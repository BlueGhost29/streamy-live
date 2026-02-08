// broadcaster.js
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
let localStream = null; 
let micStream = null; // Keep track of mic separately
let audioContext = null; // [NEW] For robust audio routing

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

        // [NEW] Initialize Audio Context on User Gesture (Click)
        // This fixes the "Viewer Audio Not Heard" issue on Android/iOS
        audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // 2. Request Media (Screen + System Audio)
        // Note: echoCancellation MUST be false for the movie audio to sound good
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                height: { ideal: 1080 },
                frameRate: { ideal: 60 },
                cursor: "always"
            },
            audio: {
                autoGainControl: false,  
                echoCancellation: false, 
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
        // 3. HOST MICROPHONE LOGIC (Improved)
        // ==========================================
        window.toggleHostMic = async (shouldEnable) => {
            try {
                if (shouldEnable) {
                    // A. Capture Mic with Voice constraints
                    micStream = await navigator.mediaDevices.getUserMedia({ 
                        audio: { 
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true
                        } 
                    });
                    
                    const micTrack = micStream.getAudioTracks()[0];
                    
                    // B. Add track to the local stream object (for future connections)
                    localStream.addTrack(micTrack);

                    // C. Add track to EXISTING connections
                    for (const id in peerConnections) {
                        const pc = peerConnections[id];
                        const senders = pc.getSenders();
                        // Check if we already sent an audio track (system audio is audio, mic is audio)
                        const alreadyHasMic = senders.some(s => s.track && s.track.id === micTrack.id);
                        
                        if (!alreadyHasMic) {
                            pc.addTrack(micTrack, localStream);
                        }
                    }
                    console.log("Host Mic Activated");
                    return true;

                } else {
                    // Mute Logic
                    if (micStream) {
                        micStream.getTracks().forEach(track => {
                            track.stop(); // Stop hardware
                            localStream.removeTrack(track); // Remove from stream object
                            
                            // Remove from active PeerConnections
                            for (const id in peerConnections) {
                                const pc = peerConnections[id];
                                const senders = pc.getSenders();
                                const senderToRemove = senders.find(s => s.track && s.track.id === track.id);
                                if (senderToRemove) {
                                    pc.removeTrack(senderToRemove);
                                }
                            }
                        });
                        micStream = null;
                    }
                    console.log("Host Mic Muted");
                    return true; 
                }
            } catch (e) {
                console.error("Mic toggle failed", e);
                alert("Could not access Microphone. Check permissions.");
                return false;
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
            // If Mic is active, it's also in localStream, so this adds both.
            localStream.getTracks().forEach(track => {
                if (track.kind === 'video' && 'contentHint' in track) {
                    track.contentHint = 'motion';
                }
                peerConnection.addTrack(track, localStream);
            });

            // B. Receive Viewer Audio (The Fix)
            // We use AudioContext instead of <audio> tag for reliable playback
            peerConnection.ontrack = (event) => {
                console.log("Receiving audio from viewer:", id);
                if (event.streams && event.streams[0]) {
                    const incomingStream = event.streams[0];
                    
                    // Create a source node from the stream
                    const source = audioContext.createMediaStreamSource(incomingStream);
                    
                    // Connect to destination (Speakers)
                    source.connect(audioContext.destination);
                }
            };

            // C. Enable Bi-directional Audio
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

        socket.on("disconnectPeer", id => {
            if (peerConnections[id]) {
                peerConnections[id].close();
                delete peerConnections[id];
                console.log(`Cleaned up connection for ${id}`);
            }
        });

        // ==========================================
        // 5. NEW: BITRATE CONTROLLER
        // ==========================================
        socket.on("bitrate_request", async (viewerId, quality) => {
            const pc = peerConnections[viewerId];
            if (!pc) return;

            console.log(`Adjusting bitrate for ${viewerId} to ${quality}`);
            
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!videoSender) return;

            const params = videoSender.getParameters();
            if (!params.encodings) params.encodings = [{}];

            // HD = 8.5 Mbps (Default), SD = 1.0 Mbps (Saver Mode)
            if (quality === 'low') {
                params.encodings[0].maxBitrate = 1000000; // 1 Mbps
            } else {
                params.encodings[0].maxBitrate = 8500000; // 8.5 Mbps
            }

            try {
                await videoSender.setParameters(params);
            } catch (err) {
                console.error("Failed to set bitrate:", err);
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
    // 8.5 Mbps is the "sweet spot" for 1080p60
    newSdp = newSdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:8500\r\n');
    return newSdp;
}