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
    try {
        console.log("Requesting Movie-Mode Display Media...");

        const stream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { 
                // "ideal" prevents crashing on 59Hz screens while aiming for 60
                height: { ideal: 1080 }, 
                frameRate: { ideal: 60 } 
            }, 
            audio: {
                // High-Fidelity Audio Settings for Movies
                autoGainControl: false,      // Don't fluctuate volume
                echoCancellation: false,     // Don't filter movie sounds
                noiseSuppression: false,     // Don't remove background explosions/music
                channelCount: 2,             // Stereo
                sampleRate: 48000,           // DVD Quality
                sampleSize: 16
            } 
        });
        
        console.log("Stream granted:", stream.id);

        videoElement.srcObject = stream;
        videoElement.muted = true; // Keep local muted to prevent feedback loop

        socket.emit("join-room", roomId, "broadcaster");
        socket.emit("broadcaster", roomId);

        // --- Socket Listeners ---
        socket.on("watcher", (id) => {
            const peerConnection = new RTCPeerConnection(configuration);
            peerConnections[id] = peerConnection;

            stream.getTracks().forEach(track => {
                // CRITICAL: contentHint = 'motion' tells the browser:
                // "This is a movie/game. Prioritize FPS over text sharpness."
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
                    // Force 8000kbps bitrate (Cinematic Quality)
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

        stream.getVideoTracks()[0].onended = () => {
            alert("Broadcast ended.");
            window.location.reload();
        };

    } catch (err) {
        console.error("Error starting broadcast: " + err);
        throw err;
    }
}

function setBandwidth(sdp) {
    // 8000kbps (8 Mbps) is the sweet spot for 1080p 60fps movies.
    // It handles fast motion (dragons flying) without blockiness.
    return sdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:8000\r\n');
}