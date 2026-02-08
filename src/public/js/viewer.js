const socket = io();

// 1. Define the STUN servers
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 2. Use 'let' because we re-create this when the broadcaster calls
let peerConnection; 

export function init(roomId, videoElement) {
    // Join Room
    socket.emit("join-room", roomId, "viewer");

    // Listen for Offer from Broadcaster
    socket.on("offer", (id, description) => {
        // FIX: Use 'configuration' here
        peerConnection = new RTCPeerConnection(configuration);
        
        peerConnection.ontrack = event => {
            videoElement.srcObject = event.streams[0];
        };

        peerConnection.onicecandidate = event => {
            if (event.candidate) socket.emit("candidate", id, event.candidate);
        };

        peerConnection.setRemoteDescription(description)
            .then(() => peerConnection.createAnswer())
            .then(sdp => peerConnection.setLocalDescription(sdp))
            .then(() => socket.emit("answer", id, peerConnection.localDescription));
    });

    socket.on("candidate", (id, candidate) => {
        if (peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error(e));
        }
    });

    socket.on("broadcaster", () => {
        socket.emit("watcher"); // Re-handshake if broadcaster refreshes
    });
    
    // Clean exit
    window.onunload = window.onbeforeunload = () => {
        socket.close();
        if (peerConnection) peerConnection.close();
    };
}