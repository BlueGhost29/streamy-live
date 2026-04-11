// src/public/js/viewer.js
import { toggleFullScreen } from './ui.js';

// ==========================================
// 1. CONFIGURATION: Azure Private Relay (Universal Mode)
// ==========================================
// This configuration allows 3 paths:
// 1. Direct P2P (Best Quality, Lowest Latency)
// 2. UDP Relay (Fast, Good for Mobile Data)
// 3. TCP Relay (Stealth, Good for University WiFi)
const configuration = {
    iceServers: [
        // 1. Google STUN (Speed Check / Direct P2P discovery)
        { urls: 'stun:stun.l.google.com:19302' },

        // 2. PRIMARY: The Fast Lane (UDP 3478)
        // Best for Sharvari's Mobile Data & Your Home WiFi.
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
    // [CRITICAL] 'iceTransportPolicy: relay' IS REMOVED.
    // This allows the browser to use Direct P2P if available.
};

// ==========================================
// 2. GLOBAL STATE
// ==========================================
let peerConnection = null;
let wakeLock = null;
let localAudioStream = null;
let isMuted = true;
let isHighQuality = true; // Default to HD
let hostId = null; // Store the host's socket ID

/**
 * Initializes the Viewer Logic.
 * @param {string} roomId - The unique room ID.
 * @param {HTMLVideoElement} videoElement - The main video player.
 * @param {object} socket - The shared Socket.io instance.
 * @param {string} username - The provided viewer name.
 */
export async function init(roomId, videoElement, socket, username) {
    console.log("Initializing Universal Viewer (Auto-Recover Mode)...");
    
    // ------------------------------------------
    // A. SYSTEM PREP
    // ------------------------------------------
    
    // 1. Prevent screen from sleeping (Critical for long movies)
    await requestWakeLock();
    
    // 2. [iOS Fix] Critical attributes for Safari
    // Without these, iOS will try to hijack the player into its native fullscreen
    // which breaks our custom UI overlay.
    videoElement.playsInline = true;
    videoElement.autoplay = true; 
    videoElement.controls = false;
    
    // 3. UI: Double Tap to Fullscreen (Mobile Friendly)
    if (videoElement.parentElement) {
        videoElement.parentElement.addEventListener("dblclick", () => {
            toggleFullScreen(document.documentElement); // Force root to hide all OS Taskbars
        });
    }

    // 4. UI: Floating Fullscreen Button (Backup)
    createFloatingButton(videoElement);

    // ------------------------------------------
    // B. QUALITY TOGGLE LOGIC
    // ------------------------------------------
    const qualityBtn = document.getElementById('qualityBtn');
    if (qualityBtn) {
        qualityBtn.onclick = (e) => {
            if(e) e.preventDefault(); // Stop any default behavior

            isHighQuality = !isHighQuality;
            
            if (isHighQuality) {
                qualityBtn.innerText = "HD";
                qualityBtn.classList.replace('text-yellow-500', 'text-green-500');
            } else {
                qualityBtn.innerText = "SD";
                qualityBtn.classList.replace('text-green-500', 'text-yellow-500');
            }

            const mode = isHighQuality ? 'high' : 'low';
            console.log(`[Quality] Requesting bitrate change to: ${mode}`);
            socket.emit("bitrate_request", roomId, mode);
        };
    }

    // ------------------------------------------
    // B.5 NIGHT MODE LOGIC (DIALOGUE COMPRESSOR)
    // ------------------------------------------
    let nightModeActive = false;
    let viewerAudioContext = null;
    let viewerCompressor = null;
    let viewerMediaSource = null;

    const nightBtn = document.getElementById('nightBtn');
    if (nightBtn) {
        nightBtn.onclick = (e) => {
            if(e) e.preventDefault();
            nightModeActive = !nightModeActive;
            
            if (nightModeActive) {
                nightBtn.classList.replace('text-indigo-400', 'text-white');
                nightBtn.classList.add('bg-indigo-600/50', 'animate-pulse');
                
                if (!viewerAudioContext) viewerAudioContext = new (window.AudioContext || window.webkitAudioContext)();
                if (viewerAudioContext.state === 'suspended') viewerAudioContext.resume();
                
                if (!viewerMediaSource && videoElement.srcObject) {
                    const audioTrack = videoElement.srcObject.getAudioTracks()[0];
                    if (audioTrack) {
                        const stream = new MediaStream([audioTrack]);
                        viewerMediaSource = viewerAudioContext.createMediaStreamSource(stream);
                        
                        viewerCompressor = viewerAudioContext.createDynamicsCompressor();
                        viewerCompressor.threshold.value = -40; // Catch everything
                        viewerCompressor.knee.value = 30;
                        viewerCompressor.ratio.value = 12; // Flatten loud noises intensely
                        viewerCompressor.attack.value = 0.003;
                        viewerCompressor.release.value = 0.25;
                        
                        // [Hardware AEC FIX] Route to HTML tag so browser can echo-cancel it
                        window.viewerAecDest = viewerAudioContext.createMediaStreamDestination();
                        viewerMediaSource.connect(viewerCompressor);
                        viewerCompressor.connect(window.viewerAecDest);
                        
                        if (!window.viewerAecPlayer) window.viewerAecPlayer = new Audio();
                        window.viewerAecPlayer.srcObject = window.viewerAecDest.stream;
                        window.viewerAecPlayer.play().catch(e=>{});
                        
                        videoElement.muted = true; // Mute Raw Audio
                        console.log("[Audio] Night Mode Activated (AEC protected)");
                    }
                } else if (viewerMediaSource) {
                    viewerMediaSource.connect(viewerCompressor);
                    videoElement.muted = true;
                }
            } else {
                nightBtn.classList.replace('text-white', 'text-indigo-400');
                nightBtn.classList.remove('bg-indigo-600/50', 'animate-pulse');
                if (viewerMediaSource && viewerCompressor) {
                    viewerMediaSource.disconnect(viewerCompressor);
                }
                videoElement.muted = false; // Restore Raw Audio
                console.log("[Audio] Night Mode Disabled");
            }
        };
    }

    // ------------------------------------------
    // C. MICROPHONE LOGIC (THE CRITICAL FIX)
    // ------------------------------------------
    const micBtn = document.getElementById('micBtn');
    const micStatus = document.getElementById('micStatus');
    
    if (micBtn) {
        micBtn.onclick = async (e) => {
            // [CRITICAL FIX] STOP PAGE RELOAD
            // This prevents the "Ghost User" issue where the socket ID changes
            if(e) {
                e.preventDefault();
                e.stopPropagation();
            }

            if (isMuted) {
                // >>>>>> TURNING MIC ON <<<<<<
                try {
                    console.log("[Mic] Requesting Access...");
                    
                    // [iOS FIX] Mobile often prefers mono (channelCount: 1)
                    // This prevents the robotic voice/echo issues on iPhones
                    const constraints = {
                        audio: { 
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                            channelCount: 1  // Crucial for iOS Safari stability
                        }
                    };

                    localAudioStream = await navigator.mediaDevices.getUserMedia(constraints);
                    const audioTrack = localAudioStream.getAudioTracks()[0];
                    console.log("[Mic] Access Granted:", audioTrack.label);
                    
                    if (peerConnection) {
                        // [PRODUCTION UPGRADE] Modern Transceiver Mapping
                        // Safely locate the sender without relying on volatile dtlsTransport states
                        const transceivers = peerConnection.getTransceivers();
                        const audioTransceiver = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
                        const audioSender = audioTransceiver ? audioTransceiver.sender : null;

                        if (audioSender) {
                            console.log("[Mic] Replacing existing silence track with Mic audio...");
                            await audioSender.replaceTrack(audioTrack);
                        } else {
                            // Fallback: If no sender exists, we must add one.
                            // This might cause a brief "Renegotiation Needed" event.
                            console.warn("[Mic] No audio sender found. Forcing AddTrack...");
                            peerConnection.addTrack(audioTrack, localAudioStream);
                        }
                    }

                    // UI Updates
                    micStatus.innerText = "Speaking";
                    micStatus.classList.add("text-red-500", "animate-pulse");
                    micBtn.classList.add("text-white");
                    isMuted = false;

                } catch (err) {
                    console.error("[Mic] Access Error:", err);
                    alert("Microphone access denied. Please allow permissions in your browser settings.");
                }
            } else {
                // >>>>>> TURNING MIC OFF <<<<<<
                console.log("[Mic] Muting...");
                
                // 1. Stop hardware to release the red dot on browser tab
                if (localAudioStream) {
                    localAudioStream.getTracks().forEach(track => {
                        track.stop();
                    });
                    localAudioStream = null;
                }
                
                // 2. Safely wipe the sender sequence (digital silence)
                if (peerConnection) {
                    const transceivers = peerConnection.getTransceivers();
                    const audioTransceiver = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
                    if (audioTransceiver && audioTransceiver.sender) {
                        audioTransceiver.sender.replaceTrack(null);
                    }
                }

                // UI Updates
                micStatus.innerText = "Muted";
                micStatus.classList.remove("text-red-500", "animate-pulse");
                micBtn.classList.remove("text-white");
                isMuted = true;
            }
        };
    }

    // ------------------------------------------
    // D. SOCKET & WEBRTC LOGIC
    // ------------------------------------------
    
    // 1. Join Room (sending username to appear in Audience List)
    console.log(`[Socket] Joining room: ${roomId} as ${username}`);
    socket.emit("join-room", roomId, "viewer", username);

    // 2. Robust Auto-Rejoin
    // If 4G drops and reconnects, this ensures we don't get stuck in limbo
    socket.on("connect", () => {
        console.log("[Socket] Reconnected! Rejoining room...");
        socket.emit("join-room", roomId, "viewer", username);
    });

    // 3. Handle WebRTC Offer
    socket.off("offer");
    socket.on("offer", async (id, description) => {
        console.log("[WebRTC] Received Offer from Host:", id);
        hostId = id; // Store the Host ID to uniquely identify them
        
        // Safety: Close existing connection if any
        if (peerConnection) {
            console.warn("[WebRTC] Closing old connection before accepting new one.");
            peerConnection.close();
        }
        
        peerConnection = new RTCPeerConnection(configuration);
        
        // Auto-Setup Transceivers based on Host Offer
        // (Rely purely on setRemoteDescription to map tracks accurately to avoid duplication holes.)

        // Handle Incoming Stream
        peerConnection.ontrack = event => {
            console.log("[WebRTC] Track received:", event.track.kind);
            
            // [iOS Fix] Direct assignment works best with unified streams
            if (event.streams && event.streams[0]) {
                videoElement.srcObject = event.streams[0];
                
                // Promise handling for play() to catch Autoplay errors
                const playPromise = videoElement.play();
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.log("[Player] Autoplay prevented. Waiting for interaction.", error);
                    });
                }
            }
        };

        // Handle ICE Candidates
        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                // console.log("[ICE] Generated candidate"); // Verbose
                socket.emit("candidate", id, event.candidate);
            }
        };
        
        // Monitor Connection Health
        peerConnection.oniceconnectionstatechange = () => {
            const state = peerConnection.iceConnectionState;
            console.log(`[ICE] Connection State: ${state}`);
            if (state === 'disconnected') {
                console.warn("Stream unstable...");
            }
            if (state === 'failed' || state === 'closed') {
                console.error("Stream failed to connect.");
                alert("Connection lost. Reloading to attempt auto-recovery.");
                window.location.reload();
            }
        };

        // Process the Offer
        try {
            await peerConnection.setRemoteDescription(description);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            console.log("[WebRTC] Sending Answer...");
            socket.emit("answer", id, peerConnection.localDescription);
        } catch (err) {
            console.error("[WebRTC] Handshake Error:", err);
        }
    });

    // 4. Handle ICE Candidates from Host
    socket.off("candidate");
    socket.on("candidate", (id, candidate) => {
        if (peerConnection && peerConnection.remoteDescription) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error("[ICE] Error adding candidate:", e));
        }
    });

    // 5. Host Signaling
    socket.off("broadcaster");
    socket.on("broadcaster", () => {
        console.log("[Signal] Broadcaster is ready. Requesting stream...");
        socket.emit("watcher"); 
    });
    
    // 6. Host Disconnect Guard
    socket.off("disconnectPeer");
    socket.on("disconnectPeer", (disconnectedId) => {
        if (disconnectedId === hostId) {
            console.log("[Signal] Host disconnected.");
            alert("The Host has ended the stream.");
            window.location.href = "/";
        } else {
            console.log(`[Signal] Viewer ${disconnectedId} left the room.`);
        }
    });
    
    // 7. Cleanup on page exit
    window.onunload = window.onbeforeunload = () => {
        if (peerConnection) peerConnection.close();
        if (wakeLock) wakeLock.release();
    };
}

// ==========================================
// 8. HELPER FUNCTIONS
// ==========================================
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log("[System] Wake Lock active");
        }
    } catch (err) {
        console.warn(`[System] Wake Lock failed: ${err.message}`);
    }
}

function createFloatingButton(videoElement) {
    if (document.getElementById('floatingFsBtn')) return;

    const btn = document.createElement("button");
    btn.id = "floatingFsBtn";
    btn.innerText = "⛶ Fullscreen";
    
    // CSS Styles
    Object.assign(btn.style, {
        position: "fixed",
        bottom: "80px",
        right: "20px",
        zIndex: "10000",
        padding: "12px 24px",
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        color: "white",
        border: "1px solid rgba(255,255,255,0.3)",
        borderRadius: "50px",
        fontSize: "14px",
        fontWeight: "bold",
        cursor: "pointer",
        backdropFilter: "blur(5px)",
        boxShadow: "0 4px 6px rgba(0,0,0,0.3)",
        transition: "opacity 0.3s"
    });

    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleFullScreen(document.documentElement);
    };
    
    document.body.appendChild(btn);
}