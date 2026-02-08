const socket = io();

// ==========================================
// 1. CONFIGURATION: Azure Private Relay
// ==========================================
// IP: 20.205.18.133 (East Asia/Pune Route)
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, // Google STUN (Speed)
        {
            // CRITICAL: TCP Mode (Punches through Jio/Hostel firewalls)
            urls: 'turn:20.205.18.133:3478?transport=tcp',
            username: 'sharvari',
            credential: 'movie'
        },
        {
            // UDP Mode (Best Quality for Movies)
            urls: 'turn:20.205.18.133:3478?transport=udp',
            username: 'sharvari',
            credential: 'movie'
        }
    ],
    iceCandidatePoolSize: 2
};

const peerConnections = {};

export async function init(roomId, videoElement) {
    // [COMPATIBILITY CHECK] Detect iOS (iPad/iPhone)
    // Apple strictly blocks 'getDisplayMedia' on mobile browsers.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        alert("HOSTING ERROR: iOS devices cannot share screen due to Apple restrictions. Please use a Laptop or Android to host.");
        window.location.href = "/"; // Send back to home
        return;
    }

    try {
        console.log("Initializing High-Fidelity Broadcaster...");

        // 2. Request Media (Adaptive Constraints)
        // We use 'ideal' to prevent crashes on non-standard screens
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                height: { ideal: 1080 }, // Aim for 1080p
                frameRate: { ideal: 60 }, // Aim for 60fps
                cursor: "always"
            },
            audio: {
                autoGainControl: false,  // High fidelity audio (No compression)
                echoCancellation: false, // Music/Game audio stays pure
                noiseSuppression: false,
                channelCount: 2          // Stereo
            }
        });

        console.log("Stream granted:", stream.id);

        videoElement.srcObject = stream;
        videoElement.muted = true; // Mute local preview to prevent feedback loop

        // Join the room
        socket.emit("join-room", roomId, "broadcaster");
        socket.emit("broadcaster", roomId);

        // --- Socket Listeners ---
        socket.on("watcher", async (id) => {
            console.log("New watcher connecting:", id);
            const peerConnection = new RTCPeerConnection(configuration);
            peerConnections[id] = peerConnection;

            // 3. Stream Optimization
            stream.getTracks().forEach(track => {
                // 'motion' is critical for movies/games to look smooth
                if (track.kind === 'video' && 'contentHint' in track) {
                    track.contentHint = 'motion';
                }
                peerConnection.addTrack(track, stream);
            });

            // 4. Hardware Acceleration & Codec Selection (VP9 > VP8 > H264)
            try {
                const transceivers = peerConnection.getTransceivers();
                for (const t of transceivers) {
                    if (t.sender.track && t.sender.track.kind === 'video') {
                        const caps = RTCRtpSender.getCapabilities('video');
                        if (caps) {
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

            // 5. ICE Candidate Handling
            peerConnection.onicecandidate = event => {
                if (event.candidate) socket.emit("candidate", id, event.candidate);
            };

            // 6. Robust Connection Monitoring
            peerConnection.oniceconnectionstatechange = () => {
                const state = peerConnection.iceConnectionState;
                console.log(`Peer ${id} connection state:`, state);
                if (state === 'failed' || state === 'closed') {
                    console.log(`Peer ${id} dropped. Cleaning up.`);
                    delete peerConnections[id];
                }
            };

            // 7. Create Offer with Bandwidth Boost
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

        // Handle User Stop Sharing via Browser UI
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

// Helper: Forces higher bitrates (6Mbps Video / 256kbps Audio)
function enhanceSDP(sdp) {
    let newSdp = sdp;
    // Force 6Mbps Video (Safe for WiFi, high quality 1080p)
    newSdp = newSdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:6000\r\n');
    // Force 256kbps Audio (High Quality)
    if (newSdp.indexOf("a=mid:audio") !== -1) {
        newSdp = newSdp.replace(/a=mid:audio\r\n/g, 'a=mid:audio\r\nb=AS:256\r\n');
    }
    return newSdp;
}