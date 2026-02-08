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
    console.log("Initializing Universal Viewer...");
    
    // [iOS Fix] Required for iPhone/iPad inline playback
    videoElement.playsInline = true;

    socket.emit("join-room", roomId, "viewer");

    socket.on("offer", async (id, description) => {
        peerConnection = new RTCPeerConnection(configuration);
        
        // [Mobile Fix] Explicitly tell the browser we only want to RECEIVE
        // This helps Android/iOS negotiate the connection faster
        peerConnection.addTransceiver('video', { direction: 'recvonly' });
        peerConnection.addTransceiver('audio', { direction: 'recvonly' });

        peerConnection.ontrack = event => {
            console.log("Track received:", event.track.kind);
            videoElement.srcObject = event.streams[0];
            
            // [Autoplay Fix]
            const playPromise = videoElement.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.log("Autoplay waiting for user interaction.", error);
                });
            }
        };

        peerConnection.onicecandidate = event => {
            if (event.candidate) socket.emit("candidate", id, event.candidate);
        };
        
        peerConnection.oniceconnectionstatechange = () => {
            if (peerConnection.iceConnectionState === 'disconnected') {
                console.log("Stream disconnected/interrupted.");
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
                .catch(e => console.error(e));
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
    };
}