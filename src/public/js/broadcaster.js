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
    // [COMPATIBILITY CHECK] Detect iOS (iPad/iPhone)
    // Apple strictly blocks 'getDisplayMedia' on mobile browsers.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        alert("Apple blocks Screen Sharing on iOS browsers. You can VIEW streams on this device, but to HOST, please use a PC, Mac, or Android.");
        window.location.href = "/"; // Send back to home
        return;
    }

    try {
        console.log("Initializing Universal Broadcaster...");

        // 1. Request Media (Adaptive Constraints)
        // We use 'ideal' so Android phones (which can't do 1080p) don't crash,
        // while Windows laptops still get the best quality.
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                height: { ideal: 1080 }, // Aim for 1080p on PC
                frameRate: { ideal: 60 } // Aim for 60fps
            },
            audio: {
                autoGainControl: false,  // High fidelity audio
                echoCancellation: false, // Music/Game audio stays pure
                noiseSuppression: false,
                channelCount: 2
            }
        });

        console.log("Stream granted:", stream.id);

        videoElement.srcObject = stream;
        videoElement.muted = true; // Mute local preview

        socket.emit("join-room", roomId, "broadcaster");
        socket.emit("broadcaster", roomId);

        // --- Socket Listeners ---
        socket.on("watcher", async (id) => {
            const peerConnection = new RTCPeerConnection(configuration);
            peerConnections[id] = peerConnection;

            // 2. Stream Optimization
            stream.getTracks().forEach(track => {
                // 'motion' is critical for movies/games
                if (track.kind === 'video' && 'contentHint' in track) {
                    track.contentHint = 'motion';
                }
                peerConnection.addTrack(track, stream);
            });

            // 3. Hardware Acceleration (Intel Iris / Android Adreno)
            try {
                const transceivers = peerConnection.getTransceivers();
                for (const t of transceivers) {
                    if (t.sender.track && t.sender.track.kind === 'video') {
                        const caps = RTCRtpSender.getCapabilities('video');
                        if (caps) {
                            // Prefer VP9 (High Efficiency), then VP8, then H.264
                            const preferredCodecs = caps.codecs.filter(c => 
                                c.mimeType === 'video/VP9' || c.mimeType === 'video/VP8'
                            );
                            if (preferredCodecs.length > 0) {
                                t.setCodecPreferences(preferredCodecs);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("Codec preference failed, using default.", e);
            }

            peerConnection.onicecandidate = event => {
                if (event.candidate) socket.emit("candidate", id, event.candidate);
            };

            const offer = await peerConnection.createOffer();
            
            // 4. Bitrate & Quality Munging
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

        stream.getVideoTracks()[0].onended = () => {
            alert("Broadcast ended.");
            window.location.reload();
        };

    } catch (err) {
        console.error("Broadcaster Error:", err);
        // If user cancelled selection, reload to reset UI
        if (err.name === 'NotAllowedError') window.location.reload();
        throw err;
    }
}

function enhanceSDP(sdp) {
    let newSdp = sdp;
    // 6Mbps Video (Safe for WiFi)
    newSdp = newSdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:6000\r\n');
    // 256kbps Audio (High Quality)
    if (newSdp.indexOf("a=mid:audio") !== -1) {
        newSdp = newSdp.replace(/a=mid:audio\r\n/g, 'a=mid:audio\r\nb=AS:256\r\n');
    }
    return newSdp;
}