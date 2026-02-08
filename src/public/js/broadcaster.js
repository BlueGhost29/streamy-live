const socket = io();

// 1. Define the STUN servers once
const configuration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 2. State object to track multiple viewers (e.g. your friend + you testing)
const peerConnections = {}; 

export async function init(roomId, videoElement) {
    socket.emit("join-room", roomId, "broadcaster");

    try {
        // Capture at Native Screen Resolution (No Downscaling)
        const stream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { 
                width: { ideal: 3840 }, // Ask for 4K
                height: { ideal: 2160 },
                frameRate: { ideal: 60 }
            }, 
            audio: {
                autoGainControl: false,
                echoCancellation: false,
                noiseSuppression: false,
                channelCount: 2
            } 
        });
        
        videoElement.srcObject = stream;
        videoElement.muted = true; // Mute local preview to prevent feedback
        socket.emit("broadcaster", roomId);
    } catch (err) {
        console.error("Error: " + err);
    }

    // When a viewer (watcher) joins
    socket.on("watcher", (id) => {
        // FIX: Use 'configuration' (matching the const above)
        const peerConnection = new RTCPeerConnection(configuration);
        peerConnections[id] = peerConnection;

        const stream = videoElement.srcObject;
        
        // Add tracks to connection
        stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));

        peerConnection.onicecandidate = event => {
            if (event.candidate) socket.emit("candidate", id, event.candidate);
        };

        peerConnection.createOffer()
            .then(sdp => {
                // THE QUALITY HACK: Force High Bitrate
                sdp.sdp = setBandwidth(sdp.sdp);
                return peerConnection.setLocalDescription(sdp);
            })
            .then(() => socket.emit("offer", id, peerConnection.localDescription));
    });

    socket.on("answer", (id, description) => {
        if (peerConnections[id]) {
            peerConnections[id].setRemoteDescription(description);
        }
    });

    socket.on("candidate", (id, candidate) => {
        if (peerConnections[id]) {
            peerConnections[id].addIceCandidate(new RTCIceCandidate(candidate));
        }
    });

    socket.on("disconnectPeer", id => {
        if (peerConnections[id]) {
            peerConnections[id].close();
            delete peerConnections[id];
        }
    });
}

// Helper: Rewrites the SDP "handshake" text to demand 6Mbps speed
function setBandwidth(sdp) {
    // Force 6000kbps (6Mbps) for video to remove browser limits
    return sdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:6000\r\n');
}