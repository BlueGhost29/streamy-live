const socket = io();

// 1. CONFIGURATION: Must match Broadcaster exactly
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp"
      ],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

let peerConnection; 

export function init(roomId, videoElement) {
    socket.emit("join-room", roomId, "viewer");

    socket.on("offer", (id, description) => {
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
        socket.emit("watcher"); 
    });
    
    // Clean exit
    window.onunload = window.onbeforeunload = () => {
        socket.close();
        if (peerConnection) peerConnection.close();
    };
}