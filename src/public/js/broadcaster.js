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

// Audio Engine (Premium Domain Native AEC)
let systemAudioTrack = null; 
let hostMicTrack = null;

/**
 * Initializes the Broadcaster Logic.
 */
export async function init(roomId, videoElement, socket) {
    console.log("Initializing Pro Broadcaster (Premium AEC Mode)...");

    // [UI] Initialize the Audience Widget
    createAudienceWidget();

    // [EARLY JOIN] Join room immediately to receive chats before answering screen capture prompts
    socket.emit("join-room", roomId, "broadcaster");

    try {

        // ==========================================
        // 2. CAPTURE MEDIA (Universal Compatibility Flow)
        // ==========================================
        console.log("Requesting Broadcast Media...");
        
        try {
            // Attempt 1: Strict High Quality desktop capture
            localStream = await navigator.mediaDevices.getDisplayMedia({
                video: { height: { ideal: 1080 }, frameRate: { ideal: 60 } },
                audio: { autoGainControl: false, echoCancellation: false, noiseSuppression: false }
            });
        } catch (err) {
            console.log("[Media] Strict bounds failed, trying generic...", err);
            try {
                // Attempt 2: Generic capture (MacOS / Android / iOS Safari)
                localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
            } catch (err2) {
                console.log("[Media] Generic Audio blocked, trying Video only...", err2);
                try {
                    // Attempt 3: Pure video fallback (iOS heavily restricts audio sometimes)
                    localStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                } catch (fallbackErr) {
                    console.log("[Media] Display Media blocked. Falling back to Camera...", fallbackErr);
                    try {
                        localStream = await navigator.mediaDevices.getUserMedia({
                            video: { facingMode: 'user', height: { ideal: 1080 } },
                            audio: false 
                        });
                        alert("Screen sharing prevented by OS constraints. Defaulting to Camera.");
                    } catch (finalErr) {
                        console.error("Critical Media Block:", finalErr);
                        alert("Unable to access Camera or Screen. Please check permissions.");
                        window.location.href = "/";
                        return;
                    }
                }
            }
        }

        // ==========================================
        // 4. STREAM UNIFICATION (Merge Video + Mixed Audio)
        // ==========================================
        // 3. TRACK SEGREGATION
        // ==========================================
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            if ('contentHint' in videoTrack) videoTrack.contentHint = 'motion';
            videoTrack.onended = () => {
                alert("Broadcast ended via system controls.");
                window.location.reload();
            };
        }

        systemAudioTrack = localStream.getAudioTracks()[0] || null;
        if (systemAudioTrack) {
            console.log("[Audio] System Audio Detected: Added to discrete Transceiver pipeline.");
        } else {
            console.warn("[Audio] No System Audio detected. Ensure 'Share Audio' was checked, or you are using Camera fallback.");
        }

        // Preview setup
        combinedStream = new MediaStream();
        if(videoTrack) combinedStream.addTrack(videoTrack);
        if(systemAudioTrack) combinedStream.addTrack(systemAudioTrack);
        
        console.log("Local Stream Ready for Preview");
        videoElement.srcObject = combinedStream;
        videoElement.muted = true; // Local mute to prevent echo

        // ==========================================
        // 5. SETUP SIGNALS
        // ==========================================
        socket.emit("broadcaster", roomId);

        // ==========================================
        // 5. HOST MICROPHONE LOGIC (Discrete Track)
        // ==========================================
        window.toggleHostMic = async (shouldEnable) => {
            try {
                if (shouldEnable) {
                    console.log("[Mic] Activating Host Mic...");
                    micStream = await navigator.mediaDevices.getUserMedia({ 
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } 
                    });
                    hostMicTrack = micStream.getAudioTracks()[0];

                    // Inject into existing active connections dynamically
                    Object.values(peerConnections).forEach(pc => {
                        const voiceTransceiver = pc.getTransceivers().find(t => t.direction === 'sendrecv' || t.direction === 'recvonly');
                        if (voiceTransceiver && voiceTransceiver.sender) {
                            voiceTransceiver.sender.replaceTrack(hostMicTrack);
                        }
                    });
                    return true;
                } else {
                    console.log("[Mic] Deactivating Host Mic...");
                    if (hostMicTrack) {
                        hostMicTrack.stop();
                        hostMicTrack = null;
                        Object.values(peerConnections).forEach(pc => {
                            const voiceTransceiver = pc.getTransceivers().find(t => t.direction === 'sendrecv' || t.direction === 'recvonly');
                            if (voiceTransceiver && voiceTransceiver.sender) {
                                voiceTransceiver.sender.replaceTrack(null);
                            }
                        });
                    }
                    if (micStream) micStream = null;
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

            // --- A. ISOLATED TRANSCEIVERS ---
            // 1. Movie Video (sendonly)
            if (videoTrack) {
                peerConnection.addTransceiver(videoTrack, {
                    direction: 'sendonly',
                    sendEncodings: [{ maxBitrate: 4000000 }] // Default to HD
                });
            }

            // 2. Movie System Audio (sendonly)
            if (systemAudioTrack) {
                peerConnection.addTransceiver(systemAudioTrack, {
                    direction: 'sendonly'
                });
            }

            // 3. Voice Call Transceiver (sendrecv)
            if (hostMicTrack) {
                peerConnection.addTransceiver(hostMicTrack, { direction: 'sendrecv' });
            } else {
                peerConnection.addTransceiver('audio', { direction: 'sendrecv' }); 
            }

            // C. Native AEC Playout for Viewer Audio
            peerConnection.ontrack = (event) => {
                const track = event.track;
                if (track.kind === 'audio') {
                    console.log(`[Audio] Receiving voice from Viewer ${id}`);
                    const viewerVoicePlayer = new Audio();
                    viewerVoicePlayer.id = `voice_${id}`;
                    viewerVoicePlayer.autoplay = true;
                    // Native AEC requirement: MUST append to DOM
                    document.body.appendChild(viewerVoicePlayer);
                    viewerVoicePlayer.srcObject = new MediaStream([track]);
                    
                    // Native HTML5 Video Ducking
                    setupNativeDucking(track, document.getElementById('mainVideo'));
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

/**
 * Native Ducking using pure HTML5 Media Elements
 * Allows analyzing Voice without routing it through AudioContext's destination
 */
function setupNativeDucking(audioTrack, videoEl) {
    if (!videoEl) return;
    try {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        const duckCtx = new AudioContext();
        const stream = new MediaStream([audioTrack]);
        const source = duckCtx.createMediaStreamSource(stream);
        const analyser = duckCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser); // We DO NOT connect to destination!
        
        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        function checkDucking() {
            analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
            let avg = sum / dataArray.length;
            
            // Only lower volume if someone is speaking
            if (avg > 15) {
                videoEl.volume = 0.3; // Duck host's own local preview playback
            } else {
                videoEl.volume = 1.0;
            }
            requestAnimationFrame(checkDucking);
        }
        checkDucking();
    } catch (e) {
        console.warn("Could not start ducking logic:", e);
    }
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