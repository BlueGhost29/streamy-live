// viewer.js
import { toggleFullScreen } from './ui.js';

// [ARCHITECTURE NOTE] Socket is injected via init(), not created here.
// This preserves the single-socket architecture.

// ==========================================
// 1. CONFIGURATION: Azure Private Relay (Universal Mode)
// ==========================================
const configuration = {
    iceServers: [
        // 1. Google STUN (Speed Check)
        { urls: 'stun:stun.l.google.com:19302' },

        // 2. PRIMARY: The Fast Lane (UDP 3478)
        // Best for Sharvari's Mobile Data & Your Home WiFi.
        {
            urls: 'turn:57.158.27.139:3478?transport=udp',
            username: 'sharvari',
            credential: 'movie'
        },

        // 3. BACKUP: The Stealth Lane (TCP 443)
        // The "University Bypass". If UDP is blocked, this saves the stream.
        {
            urls: 'turn:57.158.27.139:443?transport=tcp',
            username: 'sharvari',
            credential: 'movie'
        }
    ],
    iceCandidatePoolSize: 2,
    // [CRITICAL] We set this to 'relay' to force the usage of our server
    // This prevents the browser from wasting time trying (and failing) P2P
    iceTransportPolicy: 'relay' 
};
// Global State
let peerConnection;
let wakeLock = null;
let localAudioStream = null;
let isMuted = true;
let isHighQuality = true; // Default to HD

/**
 * Initializes the Viewer Logic.
 * @param {string} roomId - The unique room ID.
 * @param {HTMLVideoElement} videoElement - The main video player.
 * @param {object} socket - The shared Socket.io instance.
 */
export async function init(roomId, videoElement, socket) {
    console.log("Initializing Universal Viewer (Shared Socket Mode)...");
    
    // 1. Prevent screen from sleeping (Critical for long movies)
    requestWakeLock();
    
    // 2. [iOS Fix] Critical attributes for Safari
    // Without these, iOS will try to hijack the player into its native fullscreen
    // which breaks our custom UI overlay.
    videoElement.playsInline = true;
    videoElement.autoplay = true; 
    videoElement.controls = false;
    
    // 3. UI: Double Tap to Fullscreen (Mobile Friendly)
    if (videoElement.parentElement) {
        videoElement.parentElement.addEventListener("dblclick", () => {
            toggleFullScreen(videoElement.parentElement);
        });
    }

    // 4. UI: Floating Fullscreen Button (Backup)
    createFloatingButton(videoElement);

    // ==========================================
    // 5. QUALITY TOGGLE LOGIC
    // ==========================================
    const qualityBtn = document.getElementById('qualityBtn');
    if (qualityBtn) {
        qualityBtn.onclick = () => {
            isHighQuality = !isHighQuality;
            
            if (isHighQuality) {
                qualityBtn.innerText = "HD";
                qualityBtn.classList.replace('text-yellow-500', 'text-green-500');
            } else {
                qualityBtn.innerText = "SD";
                qualityBtn.classList.replace('text-green-500', 'text-yellow-500');
            }

            const mode = isHighQuality ? 'high' : 'low';
            console.log(`Requesting quality: ${mode}`);
            socket.emit("bitrate_request", roomId, mode);
        };
    }

    // ==========================================
    // 6. MICROPHONE LOGIC (Fixed for iOS/Android)
    // ==========================================
    const micBtn = document.getElementById('micBtn');
    const micStatus = document.getElementById('micStatus');
    
    if (micBtn) {
        micBtn.onclick = async () => {
            if (isMuted) {
                // --- Turn Mic ON ---
                try {
                    console.log("Requesting Mic Access...");
                    
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
                    
                    if (peerConnection) {
                        const senders = peerConnection.getSenders();
                        // Try to find an existing audio sender to replace
                        // This avoids renegotiation (which causes blips)
                        const audioSender = senders.find(s => s.track && s.track.kind === 'audio') 
                                         || senders.find(s => s.track === null && s.dtlsTransport);

                        if (audioSender) {
                            console.log("Replacing existing audio track (Zero Renegotiation)");
                            await audioSender.replaceTrack(audioTrack);
                        } else {
                            console.warn("No audio sender found. Forcing AddTrack (Might restart stream)...");
                            peerConnection.addTrack(audioTrack, localAudioStream);
                        }
                    }

                    // UI Updates
                    micStatus.innerText = "Speaking";
                    micStatus.classList.add("text-red-500", "animate-pulse");
                    micBtn.classList.add("text-white");
                    isMuted = false;

                } catch (err) {
                    console.error("Mic Access Error:", err);
                    alert("Microphone access denied. Please allow permissions in your browser settings.");
                }
            } else {
                // --- Turn Mic OFF ---
                console.log("Muting Mic...");
                // Stop hardware to release the red dot on browser tab
                if (localAudioStream) {
                    localAudioStream.getTracks().forEach(track => track.stop());
                }
                
                // Set sender track to null (silence on stream)
                if (peerConnection) {
                    const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
                    if (sender) {
                        sender.replaceTrack(null);
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

    // ==========================================
    // 7. WEBRTC CONNECTION LOGIC
    // ==========================================
    // Join the room using the Shared Socket
    socket.emit("join-room", roomId, "viewer");

    // Cleanup listeners
    socket.off("offer");
    socket.on("offer", async (id, description) => {
        console.log("Received Offer from Host");
        if (peerConnection) peerConnection.close();
        
        peerConnection = new RTCPeerConnection(configuration);
        
        // [IMPORTANT] Setup transceivers BEFORE setting remote description
        // Audio: SendRecv (For Mic), Video: RecvOnly (For Movie)
        peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
        peerConnection.addTransceiver('video', { direction: 'recvonly' });

        peerConnection.ontrack = event => {
            console.log("Track received:", event.track.kind);
            // [iOS Fix] Direct assignment works best with unified streams
            videoElement.srcObject = event.streams[0];
            
            // Promise handling for play()
            const playPromise = videoElement.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.log("Autoplay prevented. Waiting for user interaction.", error);
                    // Usually we show a "Click to Play" overlay here, but our 
                    // 'curtain' button handled the first interaction.
                });
            }
        };

        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                socket.emit("candidate", id, event.candidate);
            }
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            const state = peerConnection.iceConnectionState;
            console.log("ICE Connection State:", state);
            if (state === 'disconnected') console.warn("Stream unstable...");
            if (state === 'failed') console.error("Stream failed to connect.");
        };

        try {
            await peerConnection.setRemoteDescription(description);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit("answer", id, peerConnection.localDescription);
        } catch (err) {
            console.error("WebRTC Handshake Error:", err);
        }
    });

    socket.off("candidate");
    socket.on("candidate", (id, candidate) => {
        if (peerConnection && peerConnection.remoteDescription) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error("Error adding candidate:", e));
        }
    });

    socket.off("broadcaster");
    socket.on("broadcaster", () => {
        console.log("Broadcaster signaled ready, requesting stream...");
        socket.emit("watcher"); 
    });
    
    socket.off("disconnectPeer");
    socket.on("disconnectPeer", () => {
        alert("Host ended the stream.");
        window.location.href = "/";
    });
    
    // Cleanup on page exit
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
            console.log("Wake Lock active");
        }
    } catch (err) {
        console.warn(`Wake Lock failed: ${err.message}`);
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
        toggleFullScreen(videoElement.parentElement);
    };
    
    document.body.appendChild(btn);
}