import { toggleFullScreen } from './ui.js';

const socket = io();

// ==========================================
// 1. CONFIGURATION: Azure Private Relay
// ==========================================
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, // Google STUN (Speed)
        {
            // CRITICAL: TCP Mode (Punches through Jio/Hostel firewalls)
            urls: 'turn:20.205.18.133:3478?transport=tcp',
            username: 'sharvari',
            credential: 'movie'
        },
        {
            // UDP Mode (Best Quality for Movies)
            urls: 'turn:20.205.18.133:3478?transport=udp',
            username: 'sharvari',
            credential: 'movie'
        }
    ],
    // aggressive ICE candidate gathering
    iceCandidatePoolSize: 2
};

let peerConnection;
let wakeLock = null;

export async function init(roomId, videoElement) {
    console.log("Initializing Universal Viewer...");
    
    // [FEATURE] Keep Screen Awake (Prevent sleep during movie)
    requestWakeLock();

    // [iOS Fix] Required for iPhone/iPad inline playback
    videoElement.playsInline = true;

    // ==========================================
    // 2. UI Handlers (Double Tap & Floating Button)
    // ==========================================
    
    // A. Double Tap on the wrapper (better hit area)
    if (videoElement.parentElement) {
        videoElement.parentElement.addEventListener("dblclick", () => {
            toggleFullScreen(videoElement.parentElement);
        });
    }

    // B. Create Floating Button (Backup for iPad/Mobile)
    createFloatingButton(videoElement);

    // ==========================================
    // 3. WebRTC Connection Logic
    // ==========================================
    socket.emit("join-room", roomId, "viewer");

    socket.on("offer", async (id, description) => {
        // Close existing connection if any (prevents ghost streams)
        if (peerConnection) {
            console.warn("Closing existing connection for new offer");
            peerConnection.close();
        }
        
        peerConnection = new RTCPeerConnection(configuration);
        
        // [OPTIMIZATION] Explicitly ask for Receive-Only video/audio
        // This helps Android/iOS negotiate the connection faster
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
        peerConnection.addTransceiver('audio', { direction: 'recvonly' });

        // Handle Incoming Stream
        peerConnection.ontrack = event => {
            console.log(`Track received: ${event.track.kind}`);
            videoElement.srcObject = event.streams[0];
            
            // [Autoplay Fix] Handle browser autoplay policies
            const playPromise = videoElement.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.log("Autoplay blocked. Waiting for user interaction.", error);
                    // Optional: You could show a "Click to Play" overlay here
                });
            }
        };

        // Handle ICE Candidates
        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                socket.emit("candidate", id, event.candidate);
            }
        };
        
        // [Robustness] Connection State Monitoring
        peerConnection.oniceconnectionstatechange = () => {
            const state = peerConnection.iceConnectionState;
            console.log(`ICE Connection State: ${state}`);
            
            if (state === 'disconnected') {
                console.warn("Stream disconnected. Waiting for auto-recovery...");
            }
            if (state === 'failed') {
                console.error("Connection failed. You may need to refresh.");
                // We could trigger an automatic restartIce() here if needed
            }
        };

        // Apply Remote Description
        try {
            await peerConnection.setRemoteDescription(description);
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            
            socket.emit("answer", id, peerConnection.localDescription);
        } catch (err) {
            console.error("Error establishing connection:", err);
        }
    });

    socket.on("candidate", (id, candidate) => {
        if (peerConnection && peerConnection.remoteDescription) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error("Error adding candidate:", e));
        }
    });

    socket.on("broadcaster", () => {
        console.log("Broadcaster joined. Requesting stream...");
        socket.emit("watcher"); 
    });
    
    socket.on("disconnectPeer", () => {
        alert("Host ended the stream.");
        window.location.href = "/";
    });
    
    // Cleanup on exit
    window.onunload = window.onbeforeunload = () => {
        socket.close();
        if (peerConnection) peerConnection.close();
        if (wakeLock) wakeLock.release();
    };
}

// ==========================================
// 4. Helper Functions
// ==========================================

// [FEATURE] Wake Lock API (Keeps screen on)
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log('Screen Wake Lock active');
        }
    } catch (err) {
        console.warn(`Wake Lock failed: ${err.name}, ${err.message}`);
    }
}

// [UI] Floating Button Generator
function createFloatingButton(videoElement) {
    // Prevent duplicate buttons
    if (document.getElementById('floatingFsBtn')) return;

    const btn = document.createElement("button");
    btn.id = "floatingFsBtn";
    btn.innerText = "⛶ Fullscreen";
    
    Object.assign(btn.style, {
        position: "fixed",
        bottom: "80px", // Higher up to avoid iOS Home Bar
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
        // Use the robust UI helper from ui.js
        toggleFullScreen(videoElement.parentElement);
    };
    
    document.body.appendChild(btn);
}