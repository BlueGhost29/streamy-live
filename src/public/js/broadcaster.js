// src/public/js/broadcaster.js

// ==========================================
// 1. CONFIGURATION: Azure Private Relay (Universal Mode)
// ==========================================
// We enable BOTH UDP (Fast) and TCP (Stealth) candidates.
// We REMOVED 'relay' policy to allow Direct P2P (Best Quality).
const configuration = {
    iceServers: [
        // 1. Google STUN (Speed Check / Direct P2P)
        { urls: 'stun:stun.l.google.com:19302' },

        // 2. PRIMARY: The Fast Lane (UDP 3478)
        // Best for Mobile Data & Home WiFi.
        {
            urls: 'turn:57.158.27.139:3478?transport=udp',
            username: 'sharvari',
            credential: 'movie'
        },

        // 3. BACKUP: The Stealth Lane (TCP 443)
        // The "University Bypass". Mimics HTTPS traffic.
        {
            urls: 'turn:57.158.27.139:443?transport=tcp',
            username: 'sharvari',
            credential: 'movie'
        }
    ],
    iceCandidatePoolSize: 2
    // [CRITICAL CHANGE] Removed 'iceTransportPolicy: relay' to allow P2P.
};

// Global State Management
const peerConnections = {};
let localStream = null;      // Raw capture from screen
let combinedStream = null;   // The final "Mixed" stream sent to peers
let micStream = null;        // Raw capture from microphone

// Audio Engine (The Core Fix)
let audioContext = null; 
let audioDestination = null; // The final mix output
let systemSource = null;     // Screen Audio Input
let micSource = null;        // Mic Audio Input
let mainGainNode = null;     // Incoming Viewer Audio Booster

/**
 * Initializes the Broadcaster Logic.
 */
export async function init(roomId, videoElement, socket) {
    console.log("Initializing Pro Broadcaster (Universal Mode)...");

    // [UI] Initialize the Audience Widget
    createAudienceWidget();

    // [COMPATIBILITY] Universal Host Enabled
    // iOS and macOS fallbacks are handled dynamically during media capture.

    // [EARLY JOIN] Join room immediately to receive chats before answering screen capture prompts
    socket.emit("join-room", roomId, "broadcaster");

    try {
        // ==========================================
        // 2. SETUP AUDIO CONTEXT (The Mixer)
        // ==========================================
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
        audioDestination = audioContext.createMediaStreamDestination();
        
        // Hardware AEC Fix: Reroute mixer output through a standard HTML tag so Chrome can apply echo cancellation
        const aecDestination = audioContext.createMediaStreamDestination();
        
        mainGainNode = audioContext.createGain();
        mainGainNode.gain.value = 1.5; // Boost volume by 50% for viewers
        mainGainNode.connect(aecDestination);
        
        const aecSpeaker = new Audio();
        aecSpeaker.srcObject = aecDestination.stream;
        aecSpeaker.autoplay = true;

        // --- NEW: SPATIAL AUDIO (VIRTUAL COUCH) ---
        let isSpatialAudioEnabled = true;
        const hostPanner = audioContext.createStereoPanner();
        hostPanner.pan.value = -0.4;
        const viewerPanner = audioContext.createStereoPanner();
        viewerPanner.pan.value = 0.4;

        window.toggleSpatialAudio = () => {
            isSpatialAudioEnabled = !isSpatialAudioEnabled;
            const targetPan = isSpatialAudioEnabled ? 0.4 : 0.0;
            hostPanner.pan.setTargetAtTime(-targetPan, audioContext.currentTime, 0.1);
            viewerPanner.pan.setTargetAtTime(targetPan, audioContext.currentTime, 0.1);
            return isSpatialAudioEnabled;
        };

        // --- NEW: VOICE DUCKING ARCHITECTURE ---
        const systemAudioGain = audioContext.createGain();
        systemAudioGain.connect(audioDestination);
        
        const voiceAnalyser = audioContext.createAnalyser();
        voiceAnalyser.fftSize = 256;
        const voiceDataArray = new Uint8Array(voiceAnalyser.frequencyBinCount);
        
        function duckingLoop() {
            voiceAnalyser.getByteFrequencyData(voiceDataArray);
            let sum = 0;
            for(let i=0; i<voiceDataArray.length; i++) sum += voiceDataArray[i];
            let average = sum / voiceDataArray.length;
            
            // If someone talks (avg amplitude > 15), crush movie volume by 70%.
            if (average > 15) { 
                systemAudioGain.gain.setTargetAtTime(0.3, audioContext.currentTime, 0.1); 
            } else {
                systemAudioGain.gain.setTargetAtTime(1.0, audioContext.currentTime, 0.8);
            }
            requestAnimationFrame(duckingLoop);
        }
        duckingLoop();

        // Auto-Resume Audio Context (Fix for Chrome Autoplay Policy)
        const resumeAudio = () => {
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(() => console.log("[Audio] Engine Resumed"));
            }
        };
        document.body.addEventListener('click', resumeAudio);
        document.body.addEventListener('touchstart', resumeAudio);

        // ==========================================
        // 3. CAPTURE MEDIA (Screen + System Audio)
        // ==========================================
        console.log("Requesting Broadcast Media...");
        
        let displayMediaConstraints = {
            video: {
                height: { ideal: 1080 },
                frameRate: { ideal: 60 },
                cursor: "always",
                displaySurface: "monitor"
            },
            audio: {
                autoGainControl: false,  
                echoCancellation: false, 
                noiseSuppression: false,
                channelCount: 2          
            }
        };

        try {
            // Attempt 1: Screen + System Audio (Works on Windows/some Android)
            localStream = await navigator.mediaDevices.getDisplayMedia(displayMediaConstraints);
        } catch (err) {
            console.log("[Media] Failed to get Display Media with Audio, falling back...", err);
            
            // Attempt 2: Screen without Audio (Often required on macOS / Android)
            try {
                displayMediaConstraints.audio = false;
                localStream = await navigator.mediaDevices.getDisplayMedia(displayMediaConstraints);
            } catch (fallbackErr) {
                console.log("[Media] Display Media completely blocked or unsupported. Falling back to Camera...", fallbackErr);
                
                // Attempt 3: Front Camera (Required on iPhones/iPads/Mobile Safari)
                try {
                    localStream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: 'user', height: { ideal: 1080 } },
                        audio: false // Force host to use the UI Mic Toggle for consistency
                    });
                    alert("Screen sharing not supported or granted. Defaulting to Camera.");
                } catch (finalErr) {
                    console.error("Critical Media Block:", finalErr);
                    alert("Unable to access Camera or Screen. Please check permissions.");
                    window.location.href = "/";
                    return;
                }
            }
        }

        // ==========================================
        // 4. STREAM UNIFICATION (Merge Video + Mixed Audio)
        // ==========================================
        combinedStream = new MediaStream();

        // A. Add Video Track
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            if ('contentHint' in videoTrack) videoTrack.contentHint = 'motion';
            combinedStream.addTrack(videoTrack);

            videoTrack.onended = () => {
                alert("Broadcast ended via system controls.");
                window.location.reload();
            };
        }

        // B. Route System Audio to Mixer
        const systemAudioTrack = localStream.getAudioTracks()[0];
        if (systemAudioTrack) {
            console.log("[Audio] System Audio Detected: Routing to Mixer...");
            systemSource = audioContext.createMediaStreamSource(localStream);
            systemSource.connect(systemAudioGain); // Route through Ducking Control
        } else {
            console.warn("[Audio] No System Audio detected. Ensure 'Share Audio' was checked.");
        }

        // C. Add Mixed Audio Track to Combined Stream
        const mixedTrack = audioDestination.stream.getAudioTracks()[0];
        if (mixedTrack) combinedStream.addTrack(mixedTrack);

        // Preview setup
        console.log("Combined Stream Ready:", combinedStream.id);
        videoElement.srcObject = combinedStream;
        videoElement.muted = true; // Local mute to prevent echo

        // ==========================================
        // 5. SETUP SIGNALS
        // ==========================================
        socket.emit("broadcaster", roomId);

        // ==========================================
        // 6. HOST MICROPHONE LOGIC (Live Mixing)
        // ==========================================
        window.toggleHostMic = async (shouldEnable) => {
            try {
                if (shouldEnable) {
                    console.log("[Mic] Activating Host Mic...");
                    micStream = await navigator.mediaDevices.getUserMedia({ 
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
                    });
                    
                    micSource = audioContext.createMediaStreamSource(micStream);
                    micSource.connect(hostPanner);
                    hostPanner.connect(audioDestination);
                    micSource.connect(voiceAnalyser); // Trigger Audio Ducking
                    return true;
                } else {
                    console.log("[Mic] Deactivating Host Mic...");
                    if (micSource) { micSource.disconnect(); micSource = null; }
                    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
                    return true; 
                }
            } catch (e) {
                console.error("[Mic] Toggle failed:", e);
                return false;
            }
        };

        // ==========================================
        // 7. VIEWER HANDLING & AUDIENCE TRACKING
        // ==========================================
        socket.off("watcher");
        socket.on("watcher", async (id, username) => {
            console.log("Connecting to Viewer:", id, username);

            // [UI] Add to Viewer List
            updateAudienceList(id, "Connecting...", "orange", username);
            
            const peerConnection = new RTCPeerConnection(configuration);
            peerConnections[id] = peerConnection;

            // A. Add Tracks with Encodings (Fixes Lag / Bitrate Crash)
            combinedStream.getTracks().forEach(track => {
                if (track.kind === 'video') {
                    peerConnection.addTransceiver(track, {
                        streams: [combinedStream],
                        direction: 'sendonly',
                        sendEncodings: [
                            { maxBitrate: 4000000 } // Default to HD
                        ]
                    });
                } else if (track.kind === 'audio') {
                    // Critical Fix: Bind existing audio track as `sendrecv` so Viewer can respond!
                    peerConnection.addTransceiver(track, {
                        streams: [combinedStream],
                        direction: 'sendrecv'
                    });
                }
            });

            // Prevent duplicate transceivers
            // B. (Removed extra audio transceiver injection)

            // C. Handle Incoming Viewer Audio (Voice Call)
            peerConnection.ontrack = (event) => {
                if (event.streams && event.streams[0]) {
                    console.log(`[Audio] Receiving voice from Viewer ${id}`);
                    try {
                        const source = audioContext.createMediaStreamSource(event.streams[0]);
                        source.connect(viewerPanner);
                        viewerPanner.connect(mainGainNode); // Add to A.E.C. protected mixer
                        source.connect(voiceAnalyser); // Trigger Audio Ducking
                        
                    } catch(err) {
                        console.error("Audio Mixing Error:", err);
                    }
                }
            };

            // D. Force VP9 Codec (4K Clarity)
            try {
                const transceivers = peerConnection.getTransceivers();
                for (const t of transceivers) {
                    if (t.sender.track && t.sender.track.kind === 'video') {
                        const caps = RTCRtpSender.getCapabilities('video');
                        if (caps) {
                            const vp9 = caps.codecs.filter(c => c.mimeType === 'video/VP9');
                            if (vp9.length > 0) t.setCodecPreferences(vp9);
                        }
                    }
                }
            } catch(e) {}

            // E. ICE Handling & UI Updates
            peerConnection.onicecandidate = event => {
                if (event.candidate) socket.emit("candidate", id, event.candidate);
            };

            peerConnection.oniceconnectionstatechange = () => {
                const state = peerConnection.iceConnectionState;
                console.log(`Connection state with ${id}: ${state}`);
                
                // [UI] Update Status Dots
                if (state === 'connected') updateAudienceList(id, "Online", "#22c55e", username); // Green
                if (state === 'disconnected') updateAudienceList(id, "Unstable", "#eab308", username); // Yellow
                
                // [FIX] Garbage Collect Failed Connections
                if (state === 'failed' || state === 'closed') {
                    if (peerConnections[id]) {
                        peerConnections[id].close();
                        delete peerConnections[id];
                    }
                    removeViewerFromList(id);
                }
            };

            // F. Create Offer
            try {
                const offer = await peerConnection.createOffer();
                const enhancedSdp = enhanceSDP(offer.sdp);
                await peerConnection.setLocalDescription({ type: 'offer', sdp: enhancedSdp });
                socket.emit("offer", id, peerConnection.localDescription);
            } catch (err) {
                console.error("Error creating offer:", err);
            }
        });

        // ==========================================
        // 8. SIGNALING HANDLERS
        // ==========================================
        socket.off("answer");
        socket.on("answer", (id, description) => {
            if (peerConnections[id]) {
                peerConnections[id].setRemoteDescription(description).catch(e => console.error(e));
            }
        });

        socket.off("candidate");
        socket.on("candidate", (id, candidate) => {
            if (peerConnections[id]) {
                peerConnections[id].addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error(e));
            }
        });

        socket.off("disconnectPeer");
        socket.on("disconnectPeer", id => {
            console.log(`Viewer ${id} disconnected.`);
            if (peerConnections[id]) {
                peerConnections[id].close();
                delete peerConnections[id];
                removeViewerFromList(id);
            }
        });

        // ==========================================
        // 9. DYNAMIC BITRATE CONTROL (HD/SD)
        // ==========================================
        socket.off("bitrate_request");
        socket.on("bitrate_request", async (viewerId, quality) => {
            const pc = peerConnections[viewerId];
            if (!pc) return;
            
            console.log(`Setting bitrate for ${viewerId} to ${quality}`);
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!videoSender) return;

            const params = videoSender.getParameters();
            if (!params.encodings) params.encodings = [{}];

            if (quality === 'low') {
                params.encodings[0].maxBitrate = 1500000; // 1.5 Mbps (SD)
                params.encodings[0].scaleResolutionDownBy = 1.5; 
            } else {
                params.encodings[0].maxBitrate = 4000000; // 4 Mbps (HD)
                params.encodings[0].scaleResolutionDownBy = 1.0; 
            }

            try {
                await videoSender.setParameters(params);
            } catch (err) {
                console.error("Failed to update bitrate:", err);
            }
        });

    } catch (err) {
        console.error("Critical Broadcaster Init Error:", err);
        if (err.name === 'NotAllowedError') {
            alert("Permission Denied. Please reload and allow screen sharing.");
            window.location.reload();
        }
        throw err;
    }
}

/**
 * Helper: Forces high bitrate in SDP
 */
function enhanceSDP(sdp) {
    let newSdp = sdp;
    if (newSdp.includes("a=mid:video")) {
        newSdp = newSdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:4000\r\n');
    }
    // Optimize Voice (Opus) to pristine stereo quality
    if (newSdp.includes("a=rtpmap:111 opus/48000/2")) {
        newSdp = newSdp.replace("a=rtpmap:111 opus/48000/2\r\n", "a=rtpmap:111 opus/48000/2\r\na=fmtp:111 stereo=1; maxaveragebitrate=128000\r\n");
    }
    return newSdp;
}

// ==========================================
// 10. AUDIENCE WIDGET (UI)
// ==========================================
function createAudienceWidget() {
    if (document.getElementById('audienceWidget')) return;

    const widget = document.createElement('div');
    widget.id = 'audienceWidget';
    Object.assign(widget.style, {
        position: 'fixed', bottom: '20px', left: '20px', width: '250px',
        backgroundColor: 'rgba(0, 0, 0, 0.8)', color: 'white',
        borderRadius: '12px', padding: '15px', backdropFilter: 'blur(10px)',
        border: '1px solid rgba(255, 255, 255, 0.1)', zIndex: '9999',
        fontFamily: 'sans-serif', boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
        transition: 'opacity 0.3s ease'
    });

    widget.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #444; padding-bottom:5px;">
            <span style="font-weight:bold; color:#a855f7;">Live Audience</span>
            <span id="viewerCount" style="background:#333; padding:2px 8px; borderRadius:10px; font-size:12px;">0</span>
        </div>
        <div id="viewerList" style="max-height:150px; overflow-y:auto; font-size:13px;">
            <div id="emptyState" style="color:#666; font-style:italic; text-align:center; padding:10px;">Waiting for viewers...</div>
        </div>
    `;
    document.body.appendChild(widget);
}

function updateAudienceList(id, status, color, username) {
    const list = document.getElementById('viewerList');
    const count = document.getElementById('viewerCount');
    const emptyState = document.getElementById('emptyState');
    if (!list) return;

    if (emptyState) emptyState.style.display = 'none';

    let item = document.getElementById(`v-${id}`);
    
    let displayName = username;
    if (!displayName || displayName === "Viewer") {
        const shortId = id.substr(0, 4).toUpperCase();
        displayName = `Guest ${shortId}`;
    }
    
    const content = `
        <span style="display:flex; align-items:center;">
            <span style="width:8px; height:8px; border-radius:50%; background:${color}; margin-right:8px; box-shadow: 0 0 5px ${color};"></span>
            ${displayName}
        </span>
        <span style="font-size:11px; color:#ccc;">${status}</span>
    `;

    if (!item) {
        item = document.createElement('div');
        item.id = `v-${id}`;
        Object.assign(item.style, {
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 0', borderBottom: '1px solid #333', animation: 'fadeIn 0.5s'
        });
        item.innerHTML = content;
        list.appendChild(item);
    } else {
        item.innerHTML = content;
    }

    const total = Object.keys(peerConnections).length;
    if(count) count.innerText = total;
}

function removeViewerFromList(id) {
    const item = document.getElementById(`v-${id}`);
    if (item) item.remove();
    
    const count = document.getElementById('viewerCount');
    const total = Object.keys(peerConnections).length;
    if (count) count.innerText = total;

    const list = document.getElementById('viewerList');
    const emptyState = document.getElementById('emptyState');
    
    if (total === 0 && emptyState) {
        emptyState.style.display = 'block';
    }
}

// Add animation style dynamically
const style = document.createElement('style');
style.innerHTML = `@keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }`;
document.head.appendChild(style);