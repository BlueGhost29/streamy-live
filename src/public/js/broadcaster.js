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
        console.log("Requesting Intel Iris Xe Optimized Stream...");

        // [CRITICAL FIX] Removed 'sampleRate' and 'sampleSize' to prevent OverconstrainedError
        const stream = await navigator.mediaDevices.getDisplayMedia({ 
            video: { 
                height: { ideal: 1080 }, // Aim for 1080p
                frameRate: { ideal: 60 } // Aim for 60fps
            }, 
            audio: {
                autoGainControl: false,  // True Audio (No volume ducking)
                echoCancellation: false, // Music/Game audio stays pure
                noiseSuppression: false,
                channelCount: 2          // Stereo
            } 
        });
        
        console.log("Stream granted:", stream.id);

        videoElement.srcObject = stream;
        videoElement.muted = true; // Mute local preview to prevent feedback

        socket.emit("join-room", roomId, "broadcaster");
        socket.emit("broadcaster", roomId);

        // --- Socket Listeners ---
        socket.on("watcher", async (id) => {
            const peerConnection = new RTCPeerConnection(configuration);
            peerConnections[id] = peerConnection;

            // 1. Add Tracks & Optimize for Motion
            stream.getTracks().forEach(track => {
                if (track.kind === 'video' && 'contentHint' in track) {
                    track.contentHint = 'motion'; // Tells browser to prioritize FPS
                }
                peerConnection.addTrack(track, stream);
            });

            // 2. [NEW] Intel Iris Xe Hardware Acceleration (VP9)
            try {
                const transceivers = peerConnection.getTransceivers();
                for (const t of transceivers) {
                    if (t.sender.track && t.sender.track.kind === 'video') {
                        const caps = RTCRtpSender.getCapabilities('video');
                        if (caps) {
                            // Prefer VP9 (High Efficiency) -> VP8 -> H.264
                            const vp9 = caps.codecs.filter(c => c.mimeType === 'video/VP9');
                            if (vp9.length > 0) {
                                t.setCodecPreferences(vp9);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("VP9 Selection failed, falling back to default.", e);
            }

            peerConnection.onicecandidate = event => {
                if (event.candidate) socket.emit("candidate", id, event.candidate);
            };

            // 3. Create Offer & Enhance Bitrate
            const offer = await peerConnection.createOffer();
            const enhancedSdp = enhanceSDP(offer.sdp);
            
            await peerConnection.setLocalDescription({ type: 'offer', sdp: enhancedSdp });
            socket.emit("offer", id, peerConnection.localDescription);
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

        // Handle user clicking "Stop Sharing" on the browser UI
        stream.getVideoTracks()[0].onended = () => {
            alert("Broadcast ended.");
            window.location.reload();
        };

    } catch (err) {
        console.error("Broadcaster Error:", err);
        throw err; // Re-throw so room.html can catch it
    }
}

// [SDP Munging] Manually edit the connection setup to force higher quality
function enhanceSDP(sdp) {
    let newSdp = sdp;

    // VIDEO: 6000kbps (6Mbps). Safe for WiFi, looks great on 1080p.
    newSdp = newSdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:6000\r\n');

    // AUDIO: 256kbps. Studio quality audio.
    if (newSdp.indexOf("a=mid:audio") !== -1) {
        newSdp = newSdp.replace(/a=mid:audio\r\n/g, 'a=mid:audio\r\nb=AS:256\r\n');
    }

    return newSdp;
}