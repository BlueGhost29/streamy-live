// src/public/js/viewer.js

/**
 * Viewer Application Orchestrator
 * 
 * Orchestrates:
 * 1. WebRTC peer connection (direct STUN-only P2P)
 * 2. Discrete track routing: Movie video/audio to <video>, host voice to DOM <audio> (AEC)
 * 3. Two-way voice intercom via RTCRtpSender.replaceTrack() with zero renegotiation
 * 4. Authoritative DuckingController ducking movie audio during Host speech
 * 5. Dynamic bitrate requests (HD/SD) & dialogue night mode compressor with zero dual playout
 * 6. Screen wake lock & fullscreen controls
 */

import { toggleFullScreen } from './ui.js';
import { rtcConfiguration, BITRATE_PROFILES, getDirectConnectionDiagnostics } from './modules/core/config.js';
import { setupDialogueCompressor, setupLocalMicMonitor, DuckingController, getAudioDiagnostics, parseSDPSections } from './modules/media/audio.js';

// Global Viewer State
let peerConnection = null;
let wakeLock = null;
let localAudioStream = null;
let isMuted = true;
let isHighQuality = true; // Default to HD
let hostId = null;        // Host socket ID
let duckingController = null;
let dialogueCompressorHandle = null;
let isMicToggling = false;
let hostDisconnectTimer = null;
let intercomTransceiverRef = null;
let pendingCandidates = [];

function ensureViewerAudioPlays(audioEl, duckCtrl) {
    if (!audioEl) return;
    const playPromise = audioEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
            console.warn("[Audio] Host voice playout deferred by browser policy; binding interaction unlock:", err);
            const unlock = () => {
                audioEl.play().catch(() => {});
                if (duckCtrl && duckCtrl.speakers) {
                    duckCtrl.speakers.forEach(rec => {
                        if (rec.audioCtx && rec.audioCtx.state === 'suspended') {
                            rec.audioCtx.resume().catch(() => {});
                        }
                    });
                }
                document.removeEventListener('click', unlock);
                document.removeEventListener('touchstart', unlock);
                document.removeEventListener('keydown', unlock);
            };
            document.addEventListener('click', unlock, { once: true });
            document.addEventListener('touchstart', unlock, { once: true });
            document.addEventListener('keydown', unlock, { once: true });
        });
    }
}

function displayNotification(message, type = 'info') {
    if (typeof window !== 'undefined' && typeof window.showToast === 'function') {
        window.showToast(message, type);
    } else {
        console.warn(`[Viewer ${type.toUpperCase()}] ${message}`);
    }
}

/**
 * Initializes the Viewer Logic.
 * 
 * @param {string} roomId - Unique room code.
 * @param {HTMLVideoElement} videoElement - Main theater video player (#mainVideo).
 * @param {object} socket - Shared Socket.IO instance.
 * @param {string} username - Viewer display name.
 */
export async function init(roomId, videoElement, socket, username) {
    console.log("Initializing Universal Viewer (Modular Direct-P2P Mode)...");
    
    // Initialize authoritative DuckingController on main movie video player
    if (duckingController) {
        duckingController.destroy();
    }
    duckingController = new DuckingController(videoElement, {
        duckRatio: 0.3,
        minDuckedVolume: 0.05,
        thresholdRms: 0.02,
        silenceDelayMs: 1200
    });

    // Expose diagnostics helper on window for debugging & testing
    window.viewerAudioDiagnostics = () => getAudioDiagnostics(peerConnection);

    // ------------------------------------------
    // 1. SYSTEM PREPARATION & DISPLAY SETTINGS
    // ------------------------------------------
    
    // Keep device screen active during movie playback
    await requestWakeLock();
    
    // Critical iOS / Safari video player configuration
    videoElement.playsInline = true;
    videoElement.autoplay = true; 
    videoElement.controls = false;
    
    // Double Tap to Fullscreen (Root tab target, ignoring clicks on UI controls)
    if (videoElement.parentElement) {
        if (videoElement.parentElement._viewerDblClickHandler) {
            videoElement.parentElement.removeEventListener("dblclick", videoElement.parentElement._viewerDblClickHandler);
        }
        videoElement.parentElement._viewerDblClickHandler = (e) => {
            if (e.target && typeof e.target.closest === 'function' && e.target.closest('#controls, #reactionBar, #chatPanel, #ui-layer')) {
                return;
            }
            toggleFullScreen(document.documentElement);
        };
        videoElement.parentElement.addEventListener("dblclick", videoElement.parentElement._viewerDblClickHandler);
    }

    // ------------------------------------------
    // 2. QUALITY TOGGLE LOGIC
    // ------------------------------------------
    const qualityBtn = document.getElementById('qualityBtn');
    const qualityStatus = document.getElementById('qualityStatus');
    if (qualityBtn) {
        qualityBtn.onclick = (e) => {
            if (e) e.preventDefault();

            isHighQuality = !isHighQuality;
            const labelEl = qualityStatus || qualityBtn.querySelector('span') || qualityBtn;
            
            if (isHighQuality) {
                labelEl.innerText = "HD";
                qualityBtn.classList.remove('text-yellow-500', 'text-amber-400');
                qualityBtn.classList.add('text-emerald-400/80');
            } else {
                labelEl.innerText = "SD";
                qualityBtn.classList.remove('text-emerald-400/80', 'text-green-500');
                qualityBtn.classList.add('text-amber-400');
            }

            const mode = isHighQuality ? 'high' : 'low';
            console.log(`[Quality] Requesting bitrate mode: ${mode}`);
            socket.emit("bitrate_request", roomId, mode);
        };
    }

    // ------------------------------------------
    // 3. NIGHT MODE / DIALOGUE COMPRESSOR
    // ------------------------------------------
    let nightModeActive = false;

    const nightBtn = document.getElementById('nightBtn');
    const disableNightModeUI = () => {
        nightModeActive = false;
        if (nightBtn) {
            nightBtn.classList.remove('text-white', 'bg-indigo-600/50', 'animate-pulse');
            nightBtn.classList.add('text-indigo-300/80');
        }
        if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
            dialogueCompressorHandle.destroy();
            dialogueCompressorHandle = null;
        }
    };

    if (nightBtn) {
        nightBtn.onclick = (e) => {
            if (e) e.preventDefault();
            if (!nightModeActive) {
                const handle = setupDialogueCompressor(videoElement);
                if (!handle) {
                    displayNotification("Cozy dialogue mode requires an active movie audio stream.", "warning");
                    return;
                }
                dialogueCompressorHandle = handle;
                nightModeActive = true;
                nightBtn.classList.remove('text-indigo-300/80', 'text-indigo-400');
                nightBtn.classList.add('text-white', 'bg-indigo-600/50', 'animate-pulse');
            } else {
                disableNightModeUI();
            }
        };
    }

    // ------------------------------------------
    // 4. MICROPHONE TOGGLE LOGIC (replaceTrack)
    // ------------------------------------------
    const micBtn = document.getElementById('micBtn');
    const micStatus = document.getElementById('micStatus');

    const muteViewerMic = async () => {
        if (window._viewerMicCtrl) {
            window._viewerMicCtrl.destroy();
            window._viewerMicCtrl = null;
        }

        // Stop hardware stream to release browser mic indicator
        if (localAudioStream) {
            localAudioStream.getTracks().forEach(track => track.stop());
            localAudioStream = null;
        }
        
        // Replace sender track with digital silence without renegotiation
        if (peerConnection) {
            const voiceTransceiver = intercomTransceiverRef || peerConnection.getTransceivers().find(
                t => t.direction === 'sendrecv' || t.direction === 'sendonly' ||
                     t.currentDirection === 'sendrecv' || t.currentDirection === 'sendonly'
            );
            if (voiceTransceiver && voiceTransceiver.sender) {
                try {
                    await voiceTransceiver.sender.replaceTrack(null);
                } catch (e) {
                    console.warn("[Mic] Error replacing track with null:", e);
                }
            }
        }

        // UI Updates
        if (micStatus) {
            micStatus.innerText = "Muted";
            micStatus.classList.remove("text-red-500", "animate-pulse");
        }
        if (micBtn) {
            micBtn.classList.remove("text-white");
        }
        isMuted = true;
    };

    if (micBtn && micStatus) {
        micBtn.onclick = async (e) => {
            if (e) e.preventDefault();
            if (isMicToggling) return;
            isMicToggling = true;

            try {
                if (isMuted) {
                    // Activating microphone
                    console.log("[Mic] Requesting Voice Intercom access...");
                    
                    // Release any leftover hardware tracks
                    if (localAudioStream) {
                        localAudioStream.getTracks().forEach(t => t.stop());
                        localAudioStream = null;
                    }

                    const constraints = {
                        audio: {
                            echoCancellation: true,
                            noiseSuppression: true,
                            autoGainControl: true,
                            channelCount: 1
                        }
                    };

                    try {
                        localAudioStream = await navigator.mediaDevices.getUserMedia(constraints);
                    } catch (micErr) {
                        if (micErr && (micErr.name === 'NotAllowedError' || micErr.name === 'PermissionDeniedError' || micErr.name === 'NotFoundError' || micErr.name === 'DevicesNotFoundError')) {
                            throw micErr;
                        }
                        console.warn("[Mic] Strict mic constraints rejected; retrying with generic audio constraints...", micErr);
                        localAudioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                    }
                    const audioTrack = localAudioStream.getAudioTracks()[0];
                    if (!audioTrack) {
                        throw new Error("No audio track obtained from microphone.");
                    }
                    console.log("[Mic] Access Granted:", audioTrack.label);

                    // Handle sudden unplug or permission revocation
                    audioTrack.addEventListener('ended', () => {
                        console.log("[Mic] Audio track ended by hardware/browser.");
                        if (!isMuted) muteViewerMic();
                    });
                    
                    if (peerConnection) {
                        // Locate the voice intercom transceiver (sendrecv in screen mode, sendonly in camera mode)
                        const voiceTransceiver = intercomTransceiverRef || peerConnection.getTransceivers().find(
                            t => t.direction === 'sendrecv' || t.direction === 'sendonly' ||
                                 t.currentDirection === 'sendrecv' || t.currentDirection === 'sendonly'
                        );
                        
                        if (voiceTransceiver && voiceTransceiver.sender) {
                            console.log("[Mic] Replacing silence track with Mic audio...");
                            await voiceTransceiver.sender.replaceTrack(audioTrack);
                        } else {
                            console.warn("[Mic] No existing voice intercom transceiver found on peer connection.");
                        }
                    }

                    // UI Updates with Real-time Speech Detection
                    micStatus.innerText = "Active";
                    micBtn.classList.add("text-white");
                    isMuted = false;

                    if (window._viewerMicCtrl) window._viewerMicCtrl.destroy();
                    window._viewerMicCtrl = setupLocalMicMonitor(audioTrack, (isSpeaking) => {
                        if (isMuted) return;
                        if (isSpeaking) {
                            micStatus.innerText = "Speaking";
                            micStatus.classList.add("text-red-500", "animate-pulse");
                        } else {
                            micStatus.innerText = "Active";
                            micStatus.classList.remove("text-red-500", "animate-pulse");
                        }
                    });

                } else {
                    // Muting microphone
                    console.log("[Mic] Muting microphone...");
                    await muteViewerMic();
                }
            } catch (err) {
                console.error("[Mic] Microphone access error:", err);
                if (typeof window !== 'undefined' && !window.isSecureContext) {
                    displayNotification("Microphone access requires a Secure Context (HTTPS or localhost). Over local Wi-Fi, configure local HTTPS.", "warning");
                } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                    displayNotification("Microphone access denied. Please allow microphone permission in browser settings.", "warning");
                } else {
                    displayNotification("Unable to access microphone. Please verify device audio input.", "error");
                }
            } finally {
                isMicToggling = false;
            }
        };
    }

    // ------------------------------------------
    // 5. SOCKET & WEBRTC LIFECYCLE
    // ------------------------------------------
    
    // Handle WebRTC Offer from Broadcaster
    socket.off("offer");
    socket.on("offer", async (id, description) => {
        console.log("[WebRTC] Received Offer from Host:", id);
        if (hostId && hostId !== id) {
            const prevVoiceEl = document.getElementById(`hostVoice_${hostId}`);
            if (prevVoiceEl && prevVoiceEl.parentNode) prevVoiceEl.parentNode.removeChild(prevVoiceEl);
        }
        hostId = id;
        if (hostDisconnectTimer) {
            clearTimeout(hostDisconnectTimer);
            hostDisconnectTimer = null;
        }
        if (duckingController) {
            duckingController.unregisterVoiceTrack('host');
        }
        if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
            dialogueCompressorHandle.destroy();
            dialogueCompressorHandle = null;
        }
        
        // Safety: Close stale connection before accepting new offer
        if (peerConnection) {
            console.warn("[WebRTC] Closing prior connection before accepting offer.");
            peerConnection.close();
            window.movieStream = null;
            intercomTransceiverRef = null;
        }
        pendingCandidates = [];
        
        peerConnection = new RTCPeerConnection(rtcConfiguration);

        // Identify the Intercom media section from the Offer SDP before setRemoteDescription:
        // Programme Audio is offered as 'sendonly'; Voice Intercom is offered as 'sendrecv' (screen mode) or 'recvonly' (camera mode).
        const { mediaSections } = parseSDPSections(description && description.sdp ? description.sdp : '');
        const intercomSection = mediaSections.find(
            s => s.mediaType === 'audio' && (s.direction === 'sendrecv' || s.direction === 'recvonly')
        );
        const hasProgrammeAudioSection = mediaSections.some(
            s => s.mediaType === 'audio' && s.direction === 'sendonly'
        );
        if (nightModeActive && !hasProgrammeAudioSection) {
            disableNightModeUI();
        }
        const intercomMid = intercomSection ? intercomSection.mid : null;
        const intercomSectionIdx = intercomSection ? mediaSections.indexOf(intercomSection) : -1;

        // Discrete Incoming Stream Routing
        peerConnection.ontrack = event => {
            console.log("[WebRTC] Track received:", event.track.kind);
            const transceiver = event.transceiver;
            const currentTransceivers = peerConnection.getTransceivers();
            const isIntercomTrack = event.track.kind === 'audio' && Boolean(
                (intercomMid && transceiver && transceiver.mid === intercomMid) ||
                (!intercomMid && intercomSectionIdx >= 0 && currentTransceivers.indexOf(transceiver) === intercomSectionIdx)
            );
            
            // Movie Component (Video or Programme Audio)
            if (event.track.kind === 'video' || !isIntercomTrack) {
                if (!window.movieStream) {
                    window.movieStream = new MediaStream();
                    videoElement.srcObject = window.movieStream;
                }
                window.movieStream.addTrack(event.track);

                // Re-bind Night Mode / Dialogue Compressor if active when audio track arrives
                if (event.track.kind === 'audio' && nightModeActive) {
                    if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
                        dialogueCompressorHandle.destroy();
                    }
                    dialogueCompressorHandle = setupDialogueCompressor(videoElement);
                }
                
                const playPromise = videoElement.play();
                if (playPromise !== undefined) {
                    playPromise.catch(error => {
                        console.warn("[Player] Unmuted autoplay blocked by browser policy. Falling back to muted play...", error);
                        videoElement.muted = true;
                        videoElement.play().catch(e => console.error("[Player] Muted autoplay also blocked:", e));

                        displayNotification("Audio muted by browser policy. Tap screen to unmute.", "warning");
                        const unmuteOnInteraction = () => {
                            if (nightModeActive && dialogueCompressorHandle) {
                                if (typeof dialogueCompressorHandle.setRestoreMuted === 'function') {
                                    dialogueCompressorHandle.setRestoreMuted(false);
                                }
                                if (dialogueCompressorHandle.aecPlayer) {
                                    dialogueCompressorHandle.aecPlayer.play().catch(() => {});
                                }
                            } else {
                                videoElement.muted = false;
                            }
                            document.removeEventListener('click', unmuteOnInteraction);
                            document.removeEventListener('touchstart', unmuteOnInteraction);
                        };
                        document.addEventListener('click', unmuteOnInteraction, { once: true });
                        document.addEventListener('touchstart', unmuteOnInteraction, { once: true });
                    });
                }
            } 
            // Voice Component (Bi-directional Host Intercom)
            else if (event.track.kind === 'audio') {
                console.log("[Audio] Routing Host Voice to DOM-mounted player for platform AEC...");
                let voicePlayer = document.getElementById(`hostVoice_${hostId}`);
                if (!voicePlayer) {
                    voicePlayer = new Audio();
                    voicePlayer.id = `hostVoice_${hostId}`;
                    voicePlayer.autoplay = true;
                    voicePlayer.playsInline = true;
                    voicePlayer.setAttribute('playsinline', '');
                    // Native AEC requirement: MUST append to DOM for Chromium / WebKit AEC routing
                    document.body.appendChild(voicePlayer);
                }
                voicePlayer.srcObject = new MediaStream([event.track]);
                ensureViewerAudioPlays(voicePlayer, duckingController);

                // Register Host voice with DuckingController to duck movie audio during Host speech
                if (duckingController) {
                    duckingController.registerVoiceTrack('host', event.track);
                }

                // When Host unmutes mid-session via replaceTrack(), RTP packets begin flowing and 'unmute' fires
                event.track.addEventListener('unmute', () => {
                    const p = document.getElementById(`hostVoice_${hostId}`);
                    if (p) {
                        ensureViewerAudioPlays(p, duckingController);
                    }
                    if (duckingController && duckingController.speakers) {
                        const rec = duckingController.speakers.get('host');
                        if (rec && rec.audioCtx && rec.audioCtx.state === 'suspended') {
                            rec.audioCtx.resume().catch(() => {});
                        }
                    }
                });

                event.track.addEventListener('ended', () => {
                    if (duckingController) {
                        duckingController.unregisterVoiceTrack('host');
                    }
                    const p = document.getElementById(`hostVoice_${hostId}`);
                    if (p && p.parentNode) p.parentNode.removeChild(p);
                });
            }
        };

        // Forward ICE candidates to Host
        peerConnection.onicecandidate = event => {
            if (event.candidate) {
                socket.emit("candidate", id, event.candidate);
            }
        };
        
        // Monitor Direct Connection Health (No infinite reload loops)
        peerConnection.oniceconnectionstatechange = () => {
            const state = peerConnection.iceConnectionState;
            console.log(`[ICE] Direct Connection State: ${state}`);
            if (state === 'connected' || state === 'completed') {
                console.log("[ICE] Direct P2P connection established successfully.");
                if (!isHighQuality) {
                    socket.emit("bitrate_request", roomId, 'low');
                }
            } else if (state === 'disconnected') {
                console.warn("[ICE] Stream connection temporarily interrupted.");
            } else if (state === 'failed') {
                const diagMsg = getDirectConnectionDiagnostics('failed');
                console.error("[ICE] Direct P2P connection failed:", diagMsg);
                displayNotification(diagMsg, "error");
            } else if (state === 'closed') {
                console.log("[ICE] Peer connection closed.");
            }
        };

        // Process Offer, Configure Intercom Transceiver Direction, & Emit Answer
        try {
            const activePc = peerConnection;
            await activePc.setRemoteDescription(description);

            // Configure the Intercom transceiver to allow sending Viewer mic audio back to Host
            const transceivers = activePc.getTransceivers();
            intercomTransceiverRef = (intercomMid && transceivers.find(t => t.mid === intercomMid)) ||
                (intercomSectionIdx >= 0 && transceivers[intercomSectionIdx]) ||
                null;

            if (intercomTransceiverRef) {
                // If Host offered 'recvonly' (Camera mode), Viewer answers 'sendonly'; if 'sendrecv' (Screen mode), Viewer answers 'sendrecv'
                intercomTransceiverRef.direction = (intercomSection && intercomSection.direction === 'recvonly') ? 'sendonly' : 'sendrecv';
                if (!isMuted && localAudioStream && localAudioStream.getAudioTracks()[0] && intercomTransceiverRef.sender) {
                    await intercomTransceiverRef.sender.replaceTrack(localAudioStream.getAudioTracks()[0]);
                }
            }

            const answer = await activePc.createAnswer();
            await activePc.setLocalDescription(answer);
            
            console.log("[WebRTC] Sending Answer to Host...");
            socket.emit("answer", id, activePc.localDescription);

            // Flush any ICE candidates that arrived before setRemoteDescription/setLocalDescription completed
            const queued = pendingCandidates.filter(item => item.id === id);
            pendingCandidates = [];
            for (const item of queued) {
                if (peerConnection === activePc) {
                    await activePc.addIceCandidate(new RTCIceCandidate(item.candidate)).catch(e => console.warn("[ICE] Queued candidate error:", e));
                }
            }
        } catch (err) {
            console.error("[WebRTC] Handshake Error:", err);
        }
    });

    // Handle ICE Candidates from Host (Buffer if remoteDescription/localDescription is not yet set)
    socket.off("candidate");
    socket.on("candidate", (id, candidate) => {
        if (!candidate) return;
        if (peerConnection && peerConnection.remoteDescription && peerConnection.remoteDescription.type && peerConnection.localDescription) {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.error("[ICE] Error adding candidate:", e));
        } else {
            pendingCandidates.push({ id, candidate });
        }
    });

    // Host Joined Signal: Cancel disconnect grace timer when Host reloads/rejoins the room
    socket.off("host-joined");
    socket.on("host-joined", (newHostId) => {
        console.log("[Signal] Host joined/rejoined the room:", newHostId);
        hostId = newHostId;
        if (hostDisconnectTimer) {
            clearTimeout(hostDisconnectTimer);
            hostDisconnectTimer = null;
            displayNotification("Host reconnected to the theater. Waiting for broadcast to resume...", "info");
        }
    });

    // Broadcaster Signal: Stream is ready
    socket.off("broadcaster");
    socket.on("broadcaster", () => {
        console.log("[Signal] Broadcaster is ready. Requesting stream...");
        if (hostDisconnectTimer) {
            clearTimeout(hostDisconnectTimer);
            hostDisconnectTimer = null;
        }
        socket.emit("watcher", username); 
    });

    // Actively request stream on viewer initialization and on socket reconnects
    socket.off("connect", window._viewerReconnectHandler);
    window._viewerReconnectHandler = () => {
        socket.emit("watcher", username);
    };
    socket.on("connect", window._viewerReconnectHandler);
    if (socket.connected) {
        socket.emit("watcher", username);
    }

    // Broadcaster Signal: Host paused/stopped screen share while staying in room
    socket.off("broadcast-stopped");
    socket.on("broadcast-stopped", () => {
        console.log("[Signal] Host stopped active media broadcast.");
        if (duckingController) {
            duckingController.unregisterVoiceTrack('host');
        }
        if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
            dialogueCompressorHandle.destroy();
            dialogueCompressorHandle = null;
        }
        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }
        window.movieStream = null;
        intercomTransceiverRef = null;
        if (videoElement) videoElement.srcObject = null;
        const hostVoiceEl = document.getElementById(`hostVoice_${hostId}`);
        if (hostVoiceEl && hostVoiceEl.parentNode) hostVoiceEl.parentNode.removeChild(hostVoiceEl);
        displayNotification("The Host paused or stopped sharing. Waiting for stream to resume...", "info");
    });
    
    // Host Disconnection Guard (Aligns with server's 15-second reconnection grace period)
    socket.off("disconnectPeer");
    socket.on("disconnectPeer", (disconnectedId) => {
        if (disconnectedId === hostId) {
            console.log("[Signal] Host socket disconnected. Starting 15s reconnection grace window...");
            if (duckingController) {
                duckingController.unregisterVoiceTrack('host');
            }
            const hostVoiceEl = document.getElementById(`hostVoice_${hostId}`);
            if (hostVoiceEl && hostVoiceEl.parentNode) hostVoiceEl.parentNode.removeChild(hostVoiceEl);
            displayNotification("Host connection interrupted. Waiting up to 15s for Host to reconnect...", "warning");
            if (hostDisconnectTimer) clearTimeout(hostDisconnectTimer);
            hostDisconnectTimer = setTimeout(() => {
                if (duckingController) {
                    duckingController.destroy();
                    duckingController = null;
                }
                if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
                    dialogueCompressorHandle.destroy();
                    dialogueCompressorHandle = null;
                }
                displayNotification("The Host has ended the stream.", "info");
                setTimeout(() => {
                    window.location.href = "/";
                }, 1000);
            }, 15000);
        } else {
            console.log(`[Signal] Viewer ${disconnectedId} left the room.`);
        }
    });
    
    // Page Unload Cleanup
    window.onunload = window.onbeforeunload = () => {
        if (duckingController) {
            duckingController.destroy();
            duckingController = null;
        }
        if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
            dialogueCompressorHandle.destroy();
            dialogueCompressorHandle = null;
        }
        const hostVoiceEl = document.getElementById(`hostVoice_${hostId}`);
        if (hostVoiceEl && hostVoiceEl.parentNode) hostVoiceEl.parentNode.removeChild(hostVoiceEl);
        if (window._viewerMicCtrl) window._viewerMicCtrl.destroy();
        if (localAudioStream) {
            localAudioStream.getTracks().forEach(t => t.stop());
            localAudioStream = null;
        }
        if (peerConnection) peerConnection.close();
        if (wakeLock) wakeLock.release();
    };
}

// ------------------------------------------
// 6. HELPER UTILITIES
// ------------------------------------------

async function requestWakeLock() {
    try {
        if ('wakeLock' in navigator) {
            wakeLock = await navigator.wakeLock.request('screen');
            console.log("[System] Screen Wake Lock active");
        }
    } catch (err) {
        console.warn(`[System] Wake Lock failed: ${err.message}`);
    }
}
