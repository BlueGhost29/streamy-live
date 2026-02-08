import { toggleFullScreen } from './ui.js';

const socket = io();

// ==========================================
// 1. CONFIGURATION: Azure Private Relay
// ==========================================
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, 
        {
            urls: 'turn:20.205.18.133:3478?transport=tcp',
            username: 'sharvari',
            credential: 'movie'
        },
        {
            urls: 'turn:20.205.18.133:3478?transport=udp',
            username: 'sharvari',
            credential: 'movie'
        }
    ],
    iceCandidatePoolSize: 2
};

let peerConnection;
let wakeLock = null;
let localAudioStream = null;
let isMuted = true;

export async function init(roomId, videoElement) {
    console.log("Initializing Universal Viewer...");
    
    requestWakeLock();
    videoElement.playsInline = true;

    // A. Double Tap Fullscreen
    if (videoElement.parentElement) {
        videoElement.parentElement.addEventListener("dblclick", () => {
            toggleFullScreen(videoElement.parentElement);
        });
    }

    // B. Floating Button
    createFloatingButton(videoElement);

    // [NEW] C. Microphone Logic
    const micBtn = document.getElementById('micBtn');
    const micStatus = document.getElementById('micStatus');
    
    if (micBtn) {
        micBtn.onclick = async () => {
            if (isMuted) {
                // --- Turn Mic ON ---
                try {
                    localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    const audioTrack = localAudioStream.getAudioTracks()[0];
                    
                    if (peerConnection) {
                        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'audio');
                        if (sender) {
                            sender.replaceTrack(audioTrack);
                        } else {
                            peerConnection.addTrack(audioTrack, localAudioStream);
                        }
                    }

                    micStatus.innerText = "Speaking";
                    micStatus.classList.add("text-red-500", "animate-pulse");
                    isMuted = false;
                } catch (err) {
                    console.error("Mic Error:", err);
                    alert("Microphone access denied. Check browser permissions.");
                }
            } else {
                // --- Turn Mic OFF ---
                if (localAudioStream) {
                    localAudioStream.getTracks().forEach(track => track.stop());
                }
                micStatus.innerText = "Muted";
                micStatus.classList.remove("text-red-500", "animate-pulse");
                isMuted = true;
            }
        };
    }

    // ==========================================
    // 3. WebRTC Connection Logic
    // ==========================================
    socket.emit("join-room", roomId, "viewer");

    socket.on("offer", async (id, description) => {
        if (peerConnection) {
            peerConnection.close();
        }
        
        peerConnection = new RTCPeerConnection(configuration);
        
        // [CHANGE] Audio is now 'sendrecv' to allow talking back
        peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
        peerConnection.addTransceiver('video', { direction: 'recvonly' });

        peerConnection.ontrack = event => {
            videoElement.srcObject = event.streams[0];
            videoElement.play().catch(e => console.log("Autoplay blocked:", e));
        };

        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                socket.emit("candidate", id, event.candidate);
            }
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            const state = peerConnection.iceConnectionState;
            if (state === 'disconnected') console.warn("Stream disconnected...");
        };

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
        socket.emit("watcher"); 
    });
    
    socket.on("disconnectPeer", () => {
        alert("Host ended the stream.");
        window.location.href = "/";
    });
    
    window.onunload = window.onbeforeunload = () => {
        socket.close();
        if (peerConnection) peerConnection.close();
        if (wakeLock) wakeLock.release();
    };
}

// ==========================================
// 4. Helper Functions
// ==========================================
async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
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