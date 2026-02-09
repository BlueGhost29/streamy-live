// broadcaster.js
// [ARCHITECTURE NOTE] We do NOT initialize socket = io() here.
// We receive the shared socket instance from room.html to ensure Chat & Video sync.

// ==========================================
// 1. CONFIGURATION: Azure Private Relay
// ==========================================
// Critical for bypassing firewalls on 4G/5G networks and strict NATs.
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
    iceCandidatePoolSize: 4 // Increased pool size for faster connection start
};

// Global State Management
const peerConnections = {};
let localStream = null;      // Raw capture from screen
let combinedStream = null;   // The final "Mixed" stream sent to peers
let micStream = null;        // Raw capture from microphone

// ==========================================
// AUDIO ENGINE (The Core Fix)
// ==========================================
// We use the Web Audio API to mix System Audio + Host Mic into a single track.
// This prevents "Double Audio" echoes and ensures iOS compatibility.
let audioContext = null; 
let audioDestination = null; // The final mix output
let systemSource = null;     // Screen Audio Input
let micSource = null;        // Mic Audio Input
let mainGainNode = null;     // Incoming Viewer Audio Booster

/**
 * Initializes the Broadcaster Logic.
 * @param {string} roomId - The unique room ID.
 * @param {HTMLVideoElement} videoElement - The local preview video tag.
 * @param {object} socket - The shared Socket.io instance from room.html.
 */
export async function init(roomId, videoElement, socket) {
    console.log("Initializing Pro Broadcaster (Shared Socket Mode)...");

    // [COMPATIBILITY CHECK] iOS Hosting Block
    // iOS Safari does not support getDisplayMedia (Screen Sharing) adequately for hosting.
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIOS) {
        alert("HOSTING ERROR: iOS devices cannot share screen due to Apple restrictions. Please use a Laptop or Android to host.");
        window.location.href = "/"; 
        return;
    }

    try {
        // ==========================================
        // 2. SETUP AUDIO CONTEXT
        // ==========================================
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContext();
        
        // Create the Destination (The stream we will send to peers)
        audioDestination = audioContext.createMediaStreamDestination();
        
        // Setup Viewer Audio Booster (So Host can hear Viewers clearly)
        mainGainNode = audioContext.createGain();
        mainGainNode.gain.value = 1.5; // Boost volume by 50%
        mainGainNode.connect(audioContext.destination);

        // [CRITICAL] Auto-Resume Audio Context
        // Modern browsers suspend AudioContext if no user gesture is detected.
        // We add listeners to force resume it on the first click/tap.
        const resumeAudio = () => {
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(() => {
                    console.log("Audio Engine Resumed by User Interaction");
                });
            }
        };
        document.body.addEventListener('click', resumeAudio);
        document.body.addEventListener('touchstart', resumeAudio);

        // ==========================================
        // 3. CAPTURE MEDIA (Screen + System Audio)
        // ==========================================
        console.log("Requesting Display Media...");
        localStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                height: { ideal: 1080 },
                frameRate: { ideal: 60 },
                cursor: "always",
                displaySurface: "monitor" // Hint to browser to share full screen
            },
            audio: {
                autoGainControl: false,  
                echoCancellation: false, // OFF for high quality system audio
                noiseSuppression: false,
                channelCount: 2          // Stereo
            }
        });

        // ==========================================
        // 4. STREAM UNIFICATION (Merge Video + Mixed Audio)
        // ==========================================
        combinedStream = new MediaStream();

        // A. Add Video Track
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            // Optimization for high-motion content (Movies/Games)
            if ('contentHint' in videoTrack) {
                videoTrack.contentHint = 'motion';
            }
            combinedStream.addTrack(videoTrack);

            // Handle "Stop Sharing" floating bar
            videoTrack.onended = () => {
                alert("Broadcast ended via system controls.");
                window.location.reload();
            };
        }

        // B. Route System Audio to Mixer
        const systemAudioTrack = localStream.getAudioTracks()[0];
        if (systemAudioTrack) {
            console.log("System Audio Detected: Routing to Mixer...");
            systemSource = audioContext.createMediaStreamSource(localStream);
            systemSource.connect(audioDestination); 
            // Note: We do NOT connect systemSource to audioContext.destination (speakers) 
            // to avoid a feedback loop where the Host hears their own computer audio twice.
        } else {
            console.warn("No System Audio detected. Ensure 'Share Audio' was checked.");
        }

        // C. Add Mixed Audio Track to Combined Stream
        const mixedTrack = audioDestination.stream.getAudioTracks()[0];
        if (mixedTrack) {
            combinedStream.addTrack(mixedTrack);
        } else {
            console.warn("Audio Mixer failed to generate track.");
        }

        // Preview setup
        console.log("Combined Stream Ready:", combinedStream.id);
        videoElement.srcObject = combinedStream;
        videoElement.muted = true; // Local mute to prevent feedback

        // ==========================================
        // 5. JOIN ROOM (Socket Operations)
        // ==========================================
        // We assume the socket is already connected from room.html
        socket.emit("join-room", roomId, "broadcaster");
        socket.emit("broadcaster", roomId);

        // ==========================================
        // 6. HOST MICROPHONE LOGIC (Live Mixing)
        // ==========================================
        window.toggleHostMic = async (shouldEnable) => {
            try {
                if (shouldEnable) {
                    console.log("Activating Host Mic...");
                    micStream = await navigator.mediaDevices.getUserMedia({ 
                        audio: { 
                            echoCancellation: true, // ON for voice
                            noiseSuppression: true,
                            autoGainControl: true 
                        } 
                    });
                    
                    // Feed Mic into the Mixer
                    micSource = audioContext.createMediaStreamSource(micStream);
                    micSource.connect(audioDestination);
                    
                    console.log("Host Mic Mixed into Broadcast Stream");
                    return true;

                } else {
                    console.log("Deactivating Host Mic...");
                    // Disconnect from Mixer
                    if (micSource) {
                        micSource.disconnect();
                        micSource = null;
                    }
                    // Stop Hardware Tracks completely
                    if (micStream) {
                        micStream.getTracks().forEach(track => {
                            track.stop();
                        });
                        micStream = null;
                    }
                    console.log("Host Mic Muted");
                    return true; 
                }
            } catch (e) {
                console.error("Mic toggle failed:", e);
                alert("Could not access Microphone. Check browser permissions.");
                return false;
            }
        };

        // ==========================================
        // 7. VIEWER HANDLING (WebRTC)
        // ==========================================
        // Cleanup old listeners to prevent duplication on re-init
        socket.off("watcher");
        socket.on("watcher", async (id) => {
            console.log("Connecting to Viewer:", id);
            
            const peerConnection = new RTCPeerConnection(configuration);
            peerConnections[id] = peerConnection;

            // A. Add Tracks from Combined Stream
            // This ensures they get 1 Video + 1 Mixed Audio Track
            combinedStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, combinedStream);
            });

            // B. Prepare to Receive Audio (Transceiver)
            // Critical for Bi-directional audio (Hearing the Viewer)
            peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

            // C. Handle Incoming Audio (Viewer -> Host)
            peerConnection.ontrack = (event) => {
                if (event.streams && event.streams[0]) {
                    console.log(`Receiving Audio from ${id}`);
                    try {
                        // 1. Web Audio Processing (Boost Volume)
                        const source = audioContext.createMediaStreamSource(event.streams[0]);
                        source.connect(mainGainNode);
                        
                        // 2. iOS Persistence Hack (Hidden Audio Element)
                        // Helps keep the audio context alive on some browsers
                        const audio = new Audio();
                        audio.srcObject = event.streams[0];
                        audio.volume = 0; 
                        audio.play().catch(e => {}); 
                    } catch(err) {
                        console.warn("Audio Context Error (Viewer Connect):", err);
                    }
                }
            };

            // D. Force VP9 Codec (High Quality)
            // We prefer VP9 for better quality/bitrate ratio at 1080p
            try {
                const transceivers = peerConnection.getTransceivers();
                for (const t of transceivers) {
                    if (t.sender.track && t.sender.track.kind === 'video') {
                        const caps = RTCRtpSender.getCapabilities('video');
                        if (caps) {
                            const vp9 = caps.codecs.filter(c => c.mimeType === 'video/VP9');
                            if (vp9.length > 0) {
                                t.setCodecPreferences(vp9);
                                console.log("VP9 Codec forced for Viewer:", id);
                            }
                        }
                    }
                }
            } catch(e) {
                console.warn("Codec preference setting failed:", e);
            }

            // E. ICE Candidate Handling
            peerConnection.onicecandidate = event => {
                if (event.candidate) {
                    socket.emit("candidate", id, event.candidate);
                }
            };

            peerConnection.oniceconnectionstatechange = () => {
                const state = peerConnection.iceConnectionState;
                console.log(`Connection state with ${id}: ${state}`);
                if (state === 'failed' || state === 'closed') {
                    if (peerConnections[id]) {
                        peerConnections[id].close();
                        delete peerConnections[id];
                    }
                }
            };

            // F. Create Offer
            try {
                const offer = await peerConnection.createOffer();
                // Munge SDP to force higher start bitrate
                const enhancedSdp = enhanceSDP(offer.sdp);
                
                await peerConnection.setLocalDescription({ type: 'offer', sdp: enhancedSdp });
                socket.emit("offer", id, peerConnection.localDescription);
            } catch (err) {
                console.error("Error creating offer for viewer:", err);
            }
        });

        // ==========================================
        // 8. SIGNALING HANDLERS
        // ==========================================
        socket.off("answer");
        socket.on("answer", (id, description) => {
            if (peerConnections[id]) {
                peerConnections[id].setRemoteDescription(description).catch(e => console.error("Remote Desc Error:", e));
            }
        });

        socket.off("candidate");
        socket.on("candidate", (id, candidate) => {
            if (peerConnections[id]) {
                peerConnections[id].addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Ice Cand Error:", e));
            }
        });

        socket.off("disconnectPeer");
        socket.on("disconnectPeer", id => {
            if (peerConnections[id]) {
                console.log("Viewer disconnected cleanly:", id);
                peerConnections[id].close();
                delete peerConnections[id];
            }
        });

        // ==========================================
        // 9. DYNAMIC BITRATE CONTROL
        // ==========================================
        socket.off("bitrate_request");
        socket.on("bitrate_request", async (viewerId, quality) => {
            const pc = peerConnections[viewerId];
            if (!pc) return;
            
            console.log(`Setting bitrate for ${viewerId} to ${quality}`);
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!videoSender) return;

            const params = videoSender.getParameters();
            if (!params.encodings) {
                params.encodings = [{}];
            }

            if (quality === 'low') {
                params.encodings[0].maxBitrate = 1000000; // 1 Mbps (SD)
                params.encodings[0].scaleResolutionDownBy = 2.0; // Reduce res
            } else {
                params.encodings[0].maxBitrate = 8500000; // 8.5 Mbps (HD)
                params.encodings[0].scaleResolutionDownBy = 1.0; // Full res
            }

            try {
                await videoSender.setParameters(params);
                console.log("Bitrate updated successfully");
            } catch (err) {
                console.error("Failed to update bitrate:", err);
            }
        });

    } catch (err) {
        console.error("Critical Broadcaster Init Error:", err);
        if (err.name === 'NotAllowedError') {
            alert("Permission Denied. Please reload and allow screen sharing.");
            window.location.reload();
        }
        throw err;
    }
}

/**
 * Modifies the SDP string to force specific bandwidth parameters.
 * This is a standard WebRTC "hack" to ensure quality doesn't ramp up too slowly.
 */
function enhanceSDP(sdp) {
    let newSdp = sdp;
    // Force 8.5 Mbps Bandwidth in SDP
    // This looks for the video m-line and adds a bandwidth attribute
    if (newSdp.includes("a=mid:video")) {
        newSdp = newSdp.replace(/a=mid:video\r\n/g, 'a=mid:video\r\nb=AS:8500\r\n');
    }
    return newSdp;
}