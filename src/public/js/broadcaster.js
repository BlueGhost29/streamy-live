// src/public/js/broadcaster.js

// ==========================================
// 1. CONFIGURATION: Azure Private Relay (Stealth Mode)
// ==========================================
const configuration = {
    iceServers: [
        // 1. Google STUN (Speed Check)
        { urls: 'stun:stun.l.google.com:19302' },

        // 2. PRIMARY: The Stealth Lane (TCP 443)
        // This is the "University Bypass". It mimics HTTPS traffic.
        // We rely 100% on this because it is the only one guaranteed to pass firewalls.
        {
            urls: 'turn:57.158.27.139:443?transport=tcp',
            username: 'sharvari',
            credential: 'movie'
        }
    ],
    iceCandidatePoolSize: 2
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
    console.log("Initializing Pro Broadcaster (Shared Socket Mode)...");

    // [NEW] Initialize the Audience UI
    createAudienceWidget();

    // [COMPATIBILITY CHECK] iOS Hosting Block
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        alert("HOSTING ERROR: iOS devices cannot share screen due to Apple restrictions. Please use a Laptop or Android to host.");
        window.location.href = "/"; 
        return;
    }

    try {
        // ==========================================
        // 2. SETUP AUDIO CONTEXT
        // ==========================================
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
        audioDestination = audioContext.createMediaStreamDestination();
        
        mainGainNode = audioContext.createGain();
        mainGainNode.gain.value = 1.5; // Boost volume by 50%
        mainGainNode.connect(audioContext.destination);

        // Auto-Resume Audio Context
        const resumeAudio = () => {
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(() => console.log("Audio Engine Resumed"));
            }
        };
        document.body.addEventListener('click', resumeAudio);
        document.body.addEventListener('touchstart', resumeAudio);

        // ==========================================
        // 3. CAPTURE MEDIA (Screen + System Audio)
        // ==========================================
        console.log("Requesting Display Media...");
        localStream = await navigator.mediaDevices.getDisplayMedia({
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
        });

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
            console.log("System Audio Detected: Routing to Mixer...");
            systemSource = audioContext.createMediaStreamSource(localStream);
            systemSource.connect(audioDestination); 
        } else {
            console.warn("No System Audio detected. Ensure 'Share Audio' was checked.");
        }

        // C. Add Mixed Audio Track to Combined Stream
        const mixedTrack = audioDestination.stream.getAudioTracks()[0];
        if (mixedTrack) combinedStream.addTrack(mixedTrack);

        // Preview setup
        console.log("Combined Stream Ready:", combinedStream.id);
        videoElement.srcObject = combinedStream;
        videoElement.muted = true; // Local mute

        // ==========================================
        // 5. JOIN ROOM (Socket Operations)
        // ==========================================
        socket.emit("join-room", roomId, "broadcaster");
        socket.emit("broadcaster", roomId);

        // ==========================================
        // 6. HOST MICROPHONE LOGIC (Live Mixing)
        // ==========================================
        window.toggleHostMic = async (shouldEnable) => {
            try {
                if (shouldEnable) {
                    console.log("Activating Host Mic...");
                    micStream = await navigator.mediaDevices.getUserMedia({ 
                        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } 
                    });
                    
                    micSource = audioContext.createMediaStreamSource(micStream);
                    micSource.connect(audioDestination);
                    return true;
                } else {
                    console.log("Deactivating Host Mic...");
                    if (micSource) { micSource.disconnect(); micSource = null; }
                    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
                    return true; 
                }
            } catch (e) {
                console.error("Mic toggle failed:", e);
                return false;
            }
        };

        // ==========================================
        // 7. VIEWER HANDLING & AUDIENCE TRACKING
        // ==========================================
        socket.off("watcher");
        socket.on("watcher", async (id) => {
            console.log("Connecting to Viewer:", id);

            // [NEW UI] Add to Viewer List
            updateAudienceList(id, "Connecting...", "orange");
            
            const peerConnection = new RTCPeerConnection(configuration);
            peerConnections[id] = peerConnection;

            // A. Add Tracks
            combinedStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, combinedStream);
            });

            // B. Prepare Audio Transceiver
            peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

            // C. Handle Incoming Audio
            peerConnection.ontrack = (event) => {
                if (event.streams && event.streams[0]) {
                    try {
                        const source = audioContext.createMediaStreamSource(event.streams[0]);
                        source.connect(mainGainNode);
                        const audio = new Audio();
                        audio.srcObject = event.streams[0];
                        audio.volume = 0; 
                        audio.play().catch(e => {}); 
                    } catch(err) {}
                }
            };

            // D. Force VP9 Codec
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
                
                // [NEW UI] Update Status Dots based on connection health
                if (state === 'connected') updateAudienceList(id, "Online", "#22c55e"); // Green
                if (state === 'disconnected') updateAudienceList(id, "Unstable", "#eab308"); // Yellow
                if (state === 'failed' || state === 'closed') removeViewerFromList(id);
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
            if (peerConnections[id]) {
                peerConnections[id].close();
                delete peerConnections[id];
                // [NEW UI] Remove from list
                removeViewerFromList(id);
            }
        });

        // ==========================================
        // 9. DYNAMIC BITRATE CONTROL (RESTORED)
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
                params.encodings[0].maxBitrate = 1000000; // 1 Mbps (SD)
                params.encodings[0].scaleResolutionDownBy = 2.0; 
            } else {
                params.encodings[0].maxBitrate = 8500000; // 8.5 Mbps (HD)
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
        newSdp = newSdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:8500\r\n');
    }
    return newSdp;
}

// ==========================================
// 10. AUDIENCE WIDGET (NEW UI FEATURES)
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

function updateAudienceList(id, status, color) {
    const list = document.getElementById('viewerList');
    const count = document.getElementById('viewerCount');
    const emptyState = document.getElementById('emptyState');
    if (!list) return;

    if (emptyState) emptyState.style.display = 'none';

    // Check if ID already exists
    let item = document.getElementById(`v-${id}`);
    const shortId = id.substr(0, 4).toUpperCase();
    
    // Create the visual row for the viewer
    const content = `
        <span style="display:flex; align-items:center;">
            <span style="width:8px; height:8px; border-radius:50%; background:${color}; margin-right:8px; box-shadow: 0 0 5px ${color};"></span>
            Guest ${shortId}
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

    // Update Count
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
    
    // If no one is left, show the "Waiting..." message
    if (total === 0 && emptyState) {
        emptyState.style.display = 'block';
    }
}

// Add animation style dynamically
const style = document.createElement('style');
style.innerHTML = `@keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }`;
document.head.appendChild(style);