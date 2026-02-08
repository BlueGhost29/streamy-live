const socket = io();

// 1. CONFIGURATION: Must match Broadcaster
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
    console.log("Initializing Viewer...");
    
    // [iOS Fix] Ensure playsinline is set for iPhones
    videoElement.playsInline = true;

    socket.emit("join-room", roomId, "viewer");

    socket.on("offer", async (id, description) => {
        peerConnection = new RTCPeerConnection(configuration);
        
        // [Mobile Fix] Explicitly add a transceiver to ensure we are ready to receive
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
        peerConnection.addTransceiver('audio', { direction: 'recvonly' });

        peerConnection.ontrack = event => {
            console.log("Track received:", event.track.kind);
            videoElement.srcObject = event.streams[0];
            
            // [Autoplay Fix] Handle browser autoplay policies
            const playPromise = videoElement.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.log("Autoplay prevented. Waiting for user interaction.", error);
                    // Usually handled by the "Join" button click context
                });
            }
        };

        peerConnection.onicecandidate = event => {
            if (event.candidate) socket.emit("candidate", id, event.candidate);
        };
        
        // [Debug] Monitor Connection State
        peerConnection.oniceconnectionstatechange = () => {
            console.log("Connection State:", peerConnection.iceConnectionState);
            if (peerConnection.iceConnectionState === 'disconnected') {
                console.log("Stream disconnected.");
            }
        };

        await peerConnection.setRemoteDescription(description);
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        
        socket.emit("answer", id, peerConnection.localDescription);
    });

    socket.on("candidate", (id, candidate) => {
        if (peerConnection) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error("Error adding candidate:", e));
        }
    });

    socket.on("broadcaster", () => {
        socket.emit("watcher"); 
    });
    
    socket.on("disconnectPeer", () => {
        console.log("Broadcaster left.");
        if (peerConnection) peerConnection.close();
        alert("Stream ended by host.");
        window.location.href = "/";
    });
    
    // Clean exit
    window.onunload = window.onbeforeunload = () => {
        socket.close();
        if (peerConnection) peerConnection.close();
    };
}