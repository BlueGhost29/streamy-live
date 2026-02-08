const socket = io();

// ==========================================
// 1. CONFIGURATION: Azure Private Relay
// ==========================================
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        {
            urls: 'turn:20.205.18.133:3478?transport=tcp',
            username: 'sharvari',
            credential: 'movie'
        },
        {
            urls: 'turn:20.205.18.133:3478?transport=udp',
            username: 'sharvari',
            credential: 'movie'
        }
    ],
    iceCandidatePoolSize: 2
};

const peerConnections = {};
let localStream = null; // We need this global to mix the Mic in later

export async function init(roomId, videoElement) {
    // [COMPATIBILITY CHECK] Detect iOS
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        alert("HOSTING ERROR: iOS devices cannot share screen due to Apple restrictions. Please use a Laptop or Android to host.");
        window.location.href = "/"; 
        return;
    }

    try {
        console.log("Initializing High-Fidelity Broadcaster...");

        // 2. Request Media (Screen + System Audio)
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                height: { ideal: 1080 },
                frameRate: { ideal: 60 },
                cursor: "always"
            },
            audio: {
                autoGainControl: false,  
                echoCancellation: false, // Critical for Movie Audio quality
                noiseSuppression: false,
                channelCount: 2          
            }
        });

        console.log("Stream granted:", localStream.id);
        videoElement.srcObject = localStream;
        videoElement.muted = true; // Local mute to prevent feedback

        // Join room
        socket.emit("join-room", roomId, "broadcaster");
        socket.emit("broadcaster", roomId);

        // ==========================================
        // 3. HOST MICROPHONE LOGIC (The Missing Piece)
        // ==========================================
        // We expose this function so the UI Button can call it
        // ==========================================
        // 3. HOST MICROPHONE LOGIC
        // ==========================================
        window.toggleHostMic = async (shouldEnable) => {
            if (shouldEnable) {
                try {
                    const micStream = await navigator.mediaDevices.getUserMedia({ 
                        audio: { echoCancellation: true } 
                    });
                    const micTrack = micStream.getAudioTracks()[0];
                    
                    // [FIX] Add to localStream so NEW viewers get it automatically
                    localStream.addTrack(micTrack);

                    // Add to EXISTING viewers immediately
                    for (const id in peerConnections) {
                        const pc = peerConnections[id];
                        // check if track is already added to avoid errors
                        const senders = pc.getSenders();
                        const alreadyHasAudio = senders.some(s => s.track && s.track.kind === 'audio' && s.track.id === micTrack.id);
                        
                        if (!alreadyHasAudio) {
                            pc.addTrack(micTrack, localStream);
                        }
                    }
                    console.log("Host Mic Activated");
                    return true;
                } catch (e) {
                    console.error("Mic failed", e);
                    alert("Could not access Microphone. Check permissions.");
                    return false;
                }
            } else {
                // Mute logic: For this version, we will just stop the track 
                // to effectively mute it.
                const audioTracks = localStream.getAudioTracks();
                // Note: The first track is usually System Audio, second is Mic
                if (audioTracks.length > 1) {
                    audioTracks[1].stop(); // Stop the mic track
                    localStream.removeTrack(audioTracks[1]); // Remove from stream
                    console.log("Host Mic Muted");
                }
                return true; 
            }
        };

        // ==========================================
        // 4. SOCKET LISTENERS
        // ==========================================
        socket.on("watcher", async (id) => {
            console.log("New watcher connecting:", id);
            const peerConnection = new RTCPeerConnection(configuration);
            peerConnections[id] = peerConnection;

            // A. Send Movie (Video + System Audio)
            localStream.getTracks().forEach(track => {
                if (track.kind === 'video' && 'contentHint' in track) {
                    track.contentHint = 'motion';
                }
                peerConnection.addTrack(track, localStream);
            });

            // B. Receive Viewer Audio
            // We create a new audio element for every viewer
            peerConnection.ontrack = (event) => {
                console.log("Receiving audio from viewer:", id);
                const audio = document.createElement('audio');
                audio.srcObject = event.streams[0];
                audio.autoplay = true;
                audio.controls = false;
                audio.id = `audio-${id}`; // ID for cleanup later
                document.body.appendChild(audio);
            };

            // C. Enable Bi-directional Audio
            // We force the transceiver to 'sendrecv' so we can hear them
            const audioTransceiver = peerConnection.getTransceivers().find(t => t.sender.track && t.sender.track.kind === 'audio');
            if (audioTransceiver) {
                audioTransceiver.direction = 'sendrecv';
            } else {
                peerConnection.addTransceiver('audio', { direction: 'sendrecv' });
            }

            // D. Codec Preferences (Force VP9 for Quality)
            try {
                const transceivers = peerConnection.getTransceivers();
                for (const t of transceivers) {
                    if (t.sender.track && t.sender.track.kind === 'video') {
                        const caps = RTCRtpSender.getCapabilities('video');
                        if (caps) {
                            const preferredCodecs = caps.codecs.filter(c => 
                                c.mimeType === 'video/VP9' 
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

            // E. ICE Candidates
            peerConnection.onicecandidate = event => {
                if (event.candidate) socket.emit("candidate", id, event.candidate);
            };

            peerConnection.oniceconnectionstatechange = () => {
                const state = peerConnection.iceConnectionState;
                if (state === 'failed' || state === 'closed') {
                    delete peerConnections[id];
                }
            };

            // F. Create Offer
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

        // [CLEANUP] Remove Audio Element when Viewer leaves
        socket.on("disconnectPeer", id => {
            if (peerConnections[id]) {
                peerConnections[id].close();
                delete peerConnections[id];
                
                // Remove the invisible audio player for this user
                const audioEl = document.getElementById(`audio-${id}`);
                if (audioEl) audioEl.remove();
                console.log(`Cleaned up connection for ${id}`);
            }
        });

        localStream.getVideoTracks()[0].onended = () => {
            alert("Broadcast ended.");
            window.location.reload();
        };

    } catch (err) {
        console.error("Broadcaster Error:", err);
        if (err.name === 'NotAllowedError') window.location.reload();
        throw err;
    }
}

// Helper: Boost Bitrate for 1080p 60FPS
function enhanceSDP(sdp) {
    let newSdp = sdp;
    // 8.5 Mbps is the "sweet spot" for 1080p60 on Intel Xe
    newSdp = newSdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:8500\r\n');
    return newSdp;
}