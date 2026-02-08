const socket = io();

// 1. CONFIGURATION: Google STUN (Speed) + OpenRelay TURN (Reliability)
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

const peerConnections = {}; 

export async function init(roomId, videoElement) {
    socket.emit("join-room", roomId, "broadcaster");

    try {
        // ACTION MODE: Lock to 1080p @ 60FPS for maximum smoothness
        const stream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { 
                width: { ideal: 1920, max: 1920 },
                height: { ideal: 1080, max: 1080 },
                frameRate: { ideal: 60, min: 60 }
            }, 
            audio: {
                autoGainControl: false, // Pure audio (no filtering)
                echoCancellation: false,
                noiseSuppression: false,
                channelCount: 2
            } 
        });
        
        videoElement.srcObject = stream;
        videoElement.muted = true; // Mute local preview
        socket.emit("broadcaster", roomId);
    } catch (err) {
        console.error("Error: " + err);
    }

    socket.on("watcher", (id) => {
        const peerConnection = new RTCPeerConnection(configuration);
        peerConnections[id] = peerConnection;

        const stream = videoElement.srcObject;

        // CRITICAL FIX: The "Action Mode" Loop
        // This prioritizes motion over sharpness to prevent stuttering
        stream.getTracks().forEach(track => {
            if (track.kind === 'video' && 'contentHint' in track) {
                track.contentHint = 'motion'; 
            }
            peerConnection.addTrack(track, stream);
        });

        peerConnection.onicecandidate = event => {
            if (event.candidate) socket.emit("candidate", id, event.candidate);
        };

        peerConnection.createOffer()
            .then(sdp => {
                // Force 5000kbps bitrate (Best balance for 1080p action)
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

function setBandwidth(sdp) {
    return sdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:5000\r\n');
}