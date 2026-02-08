const socket = io();
let peerConnection;
const config = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

export function init(roomId, videoElement) {
    // 1. Join Room
    socket.emit("join-room", roomId, "viewer");

    // 2. Listen for Offer
    socket.on("offer", (id, description) => {
        peerConnection = new RTCPeerConnection(config);
        
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
        peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
            .catch(e => console.error(e));
    });

    socket.on("broadcaster", () => {
        socket.emit("watcher"); // Re-handshake
    });
    
    // Clean exit
    window.onunload = window.onbeforeunload = () => {
        socket.close();
        if (peerConnection) peerConnection.close();
    };
}