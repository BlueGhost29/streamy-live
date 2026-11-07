// src/public/js/broadcaster.js

/**
 * Broadcaster Application Orchestrator
 * 
 * Orchestrates:
 * 1. Screen capture or explicit Camera broadcasting via modules/media/capture.js
 * 2. WebRTC peer connections & 3 discrete transceiver pipelines:
 *    - Mode 'screen': Lane 1: Movie Video, Lane 2: Raw System Audio, Lane 3: Bi-directional Intercom
 *    - Mode 'camera': Lane 1: Camera Video, Lane 2: Single Microphone Programme Audio, Lane 3: Recv-only Intercom
 * 3. Audio engine enhancements:
 *    - RFC 4566 Opus stereo 48k & 128 kbps SDP tuning
 *    - Authoritative DuckingController with multi-viewer speech tracking
 *    - Click-free volume control
 * 4. Live audience HUD tracking via modules/features/audience.js
 * 5. Clean broadcast termination without forced window reload
 */

import { rtcConfiguration, BITRATE_PROFILES, getDirectConnectionDiagnostics, getCapabilityDiagnostics } from './modules/core/config.js';
import { captureScreenWithFallback, captureCameraStream, captureVideoFileStream, stopStreamTracks, CaptureError } from './modules/media/capture.js';
import { enhanceBroadcasterOffer, setupNativeDucking, DuckingController, getAudioDiagnostics } from './modules/media/audio.js';
import { createAudienceWidget, updateAudienceList, removeViewerFromList, setViewerSpeaking, clearAudienceList } from './modules/features/audience.js';

// Global Broadcaster State
const peerConnections = {};
const pendingCandidates = {};
let localStream = null;
let combinedStream = null;
let micStream = null;
let videoTrack = null;
let systemAudioTrack = null; 
let hostMicTrack = null;
let currentMode = 'screen'; // 'screen' | 'camera' | 'file'
let currentFacingMode = 'user';
let streamOptMode = 'movie'; // 'movie' | 'anime'
let duckingController = null;
let isTogglingHostMic = false;
let isFlippingCamera = false;

function ensureAudioElementPlays(audioEl, duckCtrl) {
    if (!audioEl) return;
    const playPromise = audioEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
            console.warn("[Audio] Voice playout deferred by browser policy; binding interaction unlock:", err);
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

/**
 * Initializes the Broadcaster Logic with explicit mode selection.
 * 
 * @param {string} roomId - Unique cinema room code.
 * @param {HTMLVideoElement} videoElement - Preview video element (#mainVideo).
 * @param {object} socket - Shared Socket.IO instance.
 * @param {object} [options]
 * @param {'screen'|'camera'} [options.mode='screen'] - Selected broadcasting mode.
 * @param {'user'|'environment'} [options.facingMode='user'] - Camera facing mode.
 * @param {Function} [options.onWarning] - Callback(warningCode: string) for non-fatal warnings (e.g. missing audio).
 * @param {Function} [options.onEnded] - Callback(reason: string) when broadcast ends cleanly.
 */
export async function init(roomId, videoElement, socket, options = {}) {
    const {
        mode = 'screen',
        facingMode = 'user',
        videoFile = null,
        optimizationMode = 'movie',
        onWarning = null,
        onEnded = null,
        onDemoted = null,
        onMicStateChange = null
    } = options;

    currentMode = mode;
    currentFacingMode = facingMode || 'user';
    streamOptMode = optimizationMode === 'anime' ? 'anime' : 'movie';
    console.log(`[Broadcaster] Initializing Broadcaster in mode: "${mode}" (optimization: "${streamOptMode}")...`);

    // Initialize authoritative DuckingController
    if (duckingController) {
        duckingController.destroy();
    }
    duckingController = new DuckingController(videoElement, {
        duckRatio: 0.3,
        minDuckedVolume: 0.05,
        thresholdRms: 0.02,
        silenceDelayMs: 1200
    });

    // Expose diagnostics helper for debugging & test assertion
    window.broadcasterAudioDiagnostics = (viewerId) => {
        const pc = viewerId ? peerConnections[viewerId] : Object.values(peerConnections)[0];
        return getAudioDiagnostics(pc);
    };

    // Initialize the Audience Widget HUD
    createAudienceWidget();

    // room.html owns room membership before the curtain action. Re-announce an
    // active stream after that central handler restores membership on reconnect.
    socket.off("connect", window._broadcasterReconnectHandler);
    window._broadcasterReconnectHandler = () => {
        if (localStream) {
            console.log("[Broadcaster] Socket reconnected. Re-announcing active host stream...");
            socket.emit("broadcaster", roomId);
        }
    };
    socket.on("connect", window._broadcasterReconnectHandler);

    // Clean teardown helper without full page reload
    const cleanupBroadcast = (reason = 'ended') => {
        console.log(`[Broadcaster] Stopping active broadcast (reason: ${reason})...`);
        
        socket.off("connect", window._broadcasterReconnectHandler);
        socket.off("watcher");
        socket.off("answer");
        socket.off("candidate");
        socket.off("disconnectPeer");
        socket.off("bitrate_request");

        if (reason !== 'demoted') {
            socket.emit("broadcast-stopped", roomId);
        }
        clearAudienceList();

        if (duckingController) {
            duckingController.destroy();
            duckingController = null;
        }

        if (videoTrack) {
            videoTrack.onended = null;
        }

        stopStreamTracks(localStream);
        stopStreamTracks(micStream);
        localStream = null;
        combinedStream = null;
        micStream = null;
        videoTrack = null;
        systemAudioTrack = null;
        hostMicTrack = null;

        if (typeof onMicStateChange === 'function') {
            onMicStateChange(false);
        }

        if (videoElement) {
            videoElement.srcObject = null;
        }

        // Remove any mounted viewer voice audio elements and close peer connections
        Object.keys(peerConnections).forEach(id => {
            const voicePlayer = document.getElementById(`voice_${id}`);
            if (voicePlayer && voicePlayer.parentNode) {
                voicePlayer.parentNode.removeChild(voicePlayer);
            }
            try {
                peerConnections[id].oniceconnectionstatechange = null;
                peerConnections[id].onicecandidate = null;
                peerConnections[id].ontrack = null;
                peerConnections[id].close();
            } catch (e) {
                console.warn(`[Broadcaster] Error closing connection ${id}:`, e);
            }
            delete peerConnections[id];
            delete pendingCandidates[id];
        });
        Object.keys(pendingCandidates).forEach(id => delete pendingCandidates[id]);
        window.flipHostCamera = null;
        window.setStreamOptimizationMode = null;

        if (typeof onEnded === 'function') {
            onEnded(reason);
        }
    };

    window.stopBroadcast = cleanupBroadcast;
    window.broadcaster = {
        get peerConnections() { return peerConnections; },
        get mode() { return currentMode; },
        get optimizationMode() { return streamOptMode; },
        get stream() { return localStream; },
        get systemAudioTrack() { return systemAudioTrack; },
        get hostMicTrack() { return hostMicTrack; },
        get facingMode() { return currentFacingMode; },
        stop: cleanupBroadcast
    };

    // Live Stream Content Optimization Switcher ('movie' <-> 'anime')
    window.setStreamOptimizationMode = async (optMode) => {
        streamOptMode = optMode === 'anime' ? 'anime' : 'movie';
        if (videoTrack && 'contentHint' in videoTrack) {
            if (currentMode === 'camera') {
                videoTrack.contentHint = 'detail';
            } else {
                videoTrack.contentHint = streamOptMode === 'anime' ? 'detail' : 'motion';
            }
        }
        const targetProfile = streamOptMode === 'anime' ? BITRATE_PROFILES.ANIME : BITRATE_PROFILES.HD;
        await Promise.all(Object.values(peerConnections).map(async pc => {
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!videoSender) return;
            try {
                const params = videoSender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                params.degradationPreference = targetProfile.degradationPreference;
                params.encodings[0].maxBitrate = targetProfile.maxBitrate;
                params.encodings[0].scaleResolutionDownBy = targetProfile.scaleResolutionDownBy;
                await videoSender.setParameters(params);
            } catch (e) {
                console.warn("[Broadcaster] Sender optimization update warning:", e);
            }
        }));
        return streamOptMode;
    };

    try {
        videoTrack = null;

        if (mode === 'camera') {
            // ==========================================
            // EXPLICIT CAMERA BROADCASTING PIPELINE
            // ==========================================
            console.log("[Broadcaster] Starting Live Camera capture...");
            localStream = await captureCameraStream({ facingMode: currentFacingMode, audio: true });
            
            videoTrack = localStream.getVideoTracks()[0] || null;
            if (videoTrack && 'contentHint' in videoTrack) {
                videoTrack.contentHint = 'detail';
            }

            // Primary Programme Audio: Camera Host Microphone (with AEC/AGC/NS)
            systemAudioTrack = localStream.getAudioTracks()[0] || null;
            hostMicTrack = null; // Prevent microphone duplication into Lane 3

            if (typeof onMicStateChange === 'function') {
                onMicStateChange(Boolean(systemAudioTrack && systemAudioTrack.enabled));
            }

            // Camera Mute Handler: Toggles enabled on the single primary audio track
            window.toggleHostMic = async (shouldEnable) => {
                if (systemAudioTrack) {
                    systemAudioTrack.enabled = Boolean(shouldEnable);
                    if (typeof onMicStateChange === 'function') {
                        onMicStateChange(Boolean(systemAudioTrack.enabled));
                    }
                    return true;
                }
                return false;
            };

            // Live Camera Flip Handler (Front <-> Rear for iPad, Android, and multi-cam desktops)
            window.flipHostCamera = async () => {
                if (currentMode !== 'camera' || !localStream || isFlippingCamera) return null;
                isFlippingCamera = true;
                const nextFacing = currentFacingMode === 'user' ? 'environment' : 'user';
                try {
                    const newCamStream = await captureCameraStream({ facingMode: nextFacing, audio: false });
                    const newVideoTrack = newCamStream.getVideoTracks()[0];
                    if (!newVideoTrack) {
                        stopStreamTracks(newCamStream);
                        return null;
                    }
                    currentFacingMode = nextFacing;
                    if ('contentHint' in newVideoTrack) {
                        newVideoTrack.contentHint = 'detail';
                    }

                    if (videoTrack) {
                        videoTrack.onended = null;
                        try { videoTrack.stop(); } catch (e) {}
                        if (localStream && typeof localStream.removeTrack === 'function') {
                            localStream.removeTrack(videoTrack);
                        }
                    }

                    if (localStream && typeof localStream.addTrack === 'function') {
                        localStream.addTrack(newVideoTrack);
                    }
                    videoTrack = newVideoTrack;
                    bindVideoTrackEnded(videoTrack);

                    combinedStream = new MediaStream();
                    if (videoTrack) combinedStream.addTrack(videoTrack);
                    if (systemAudioTrack) combinedStream.addTrack(systemAudioTrack);
                    if (videoElement) {
                        videoElement.srcObject = combinedStream;
                        videoElement.muted = true;
                        videoElement.play().catch(() => {});
                    }

                    await Promise.all(Object.values(peerConnections).map(async pc => {
                        const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                        if (videoSender) {
                            await videoSender.replaceTrack(videoTrack);
                        }
                    }));

                    return currentFacingMode;
                } catch (err) {
                    console.warn("[Broadcaster] Camera flip failed:", err);
                    return null;
                } finally {
                    isFlippingCamera = false;
                }
            };

        } else {
            window.flipHostCamera = null;
            // ==========================================
            // DESKTOP SCREEN SHARE OR LOCAL VIDEO FILE PIPELINE
            // ==========================================
            if (mode === 'file') {
                console.log("[Broadcaster] Starting Local Video File stream...");
                localStream = await captureVideoFileStream(videoFile, videoElement);
            } else {
                console.log("[Broadcaster] Starting Screen Share capture...");
                localStream = await captureScreenWithFallback();
            }
            
            videoTrack = localStream.getVideoTracks()[0] || null;
            if (videoTrack && 'contentHint' in videoTrack) {
                videoTrack.contentHint = streamOptMode === 'anime' ? 'detail' : 'motion';
            }

            systemAudioTrack = localStream.getAudioTracks()[0] || null;
            if (systemAudioTrack) {
                console.log("[Audio] System Audio Detected: Allocated to discrete Movie Audio lane.");
            } else {
                console.warn("[Audio] No System Audio detected. Broadcasting video only.");
                if (typeof onWarning === 'function') {
                    onWarning('missing_audio');
                }
            }

            if (typeof onMicStateChange === 'function') {
                onMicStateChange(false);
            }

            // Screen Sharing Mic Handler: Dynamically acquires separate intercom mic track via replaceTrack
            window.toggleHostMic = async (shouldEnable) => {
                if (isTogglingHostMic) return false;
                isTogglingHostMic = true;

                try {
                    if (shouldEnable) {
                        console.log("[Mic] Activating Host Voice Intercom...");
                        
                        // Stop any prior mic stream before acquiring fresh device
                        if (micStream) {
                            stopStreamTracks(micStream);
                            micStream = null;
                        }

                        try {
                            micStream = await navigator.mediaDevices.getUserMedia({ 
                                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } 
                            });
                        } catch (micErr) {
                            if (micErr && (micErr.name === 'NotAllowedError' || micErr.name === 'PermissionDeniedError' || micErr.name === 'NotFoundError' || micErr.name === 'DevicesNotFoundError')) {
                                throw micErr;
                            }
                            console.warn("[Mic] Strict mic constraints rejected; retrying with generic audio constraints...", micErr);
                            micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                        }
                        hostMicTrack = micStream.getAudioTracks()[0];

                        if (!hostMicTrack) {
                            throw new Error("No host microphone track acquired.");
                        }

                        // Handle sudden unplug or permission revocation
                        hostMicTrack.addEventListener('ended', () => {
                            console.log("[Mic] Host microphone track ended.");
                            if (window.toggleHostMic) {
                                window.toggleHostMic(false);
                            }
                        });

                        // Inject into existing active peer connections dynamically via replaceTrack
                        const replacePromises = Object.values(peerConnections).map(async pc => {
                            const voiceTransceiver = pc.getTransceivers().find(
                                t => t.direction === 'sendrecv' || t.currentDirection === 'sendrecv'
                            );
                            if (voiceTransceiver && voiceTransceiver.sender) {
                                await voiceTransceiver.sender.replaceTrack(hostMicTrack);
                            }
                        });
                        await Promise.all(replacePromises);
                        if (typeof onMicStateChange === 'function') onMicStateChange(true);
                        return true;
                    } else {
                        console.log("[Mic] Deactivating Host Voice Intercom...");
                        if (hostMicTrack) {
                            hostMicTrack.stop();
                            hostMicTrack = null;
                        }
                        if (micStream) {
                            stopStreamTracks(micStream);
                            micStream = null;
                        }

                        const clearPromises = Object.values(peerConnections).map(async pc => {
                            const voiceTransceiver = pc.getTransceivers().find(
                                t => t.direction === 'sendrecv' || t.currentDirection === 'sendrecv'
                            );
                            if (voiceTransceiver && voiceTransceiver.sender) {
                                await voiceTransceiver.sender.replaceTrack(null);
                            }
                        });
                        await Promise.all(clearPromises);
                        if (typeof onMicStateChange === 'function') onMicStateChange(false);
                        return true; 
                    }
                } catch (e) {
                    console.error("[Mic] Toggle failed:", e);
                    return false;
                } finally {
                    isTogglingHostMic = false;
                }
            };
        }

        if (!localStream || !videoTrack) {
            throw new CaptureError("No video track acquired from capture.", "failed");
        }

        // Attach clean termination on OS/browser share controls stop (or recover camera on transient device reset)
        const bindVideoTrackEnded = (track) => {
            if (!track) return;
            track.onended = async () => {
                if (!localStream) return;
                if (currentMode === 'camera') {
                    console.warn("[Broadcaster] Camera track ended unexpectedly; attempting seamless recovery...");
                    try {
                        const prevEnabled = systemAudioTrack ? systemAudioTrack.enabled : true;
                        const recoveredStream = await captureCameraStream({ facingMode: currentFacingMode, audio: true });
                        if (!localStream) {
                            stopStreamTracks(recoveredStream);
                            return;
                        }
                        stopStreamTracks(localStream);
                        localStream = recoveredStream;
                        videoTrack = localStream.getVideoTracks()[0] || null;
                        if (videoTrack && 'contentHint' in videoTrack) {
                            videoTrack.contentHint = 'detail';
                        }
                        systemAudioTrack = localStream.getAudioTracks()[0] || null;
                        if (systemAudioTrack) {
                            systemAudioTrack.enabled = prevEnabled;
                        }
                        bindVideoTrackEnded(videoTrack);

                        combinedStream = new MediaStream();
                        if (videoTrack) combinedStream.addTrack(videoTrack);
                        if (systemAudioTrack) combinedStream.addTrack(systemAudioTrack);
                        if (videoElement) {
                            videoElement.srcObject = combinedStream;
                            videoElement.muted = true;
                        }

                        await Promise.all(Object.values(peerConnections).map(async pc => {
                            const transceivers = pc.getTransceivers();
                            for (const t of transceivers) {
                                if (t.direction === 'sendonly' && t.sender) {
                                    if (t.receiver && t.receiver.track && t.receiver.track.kind === 'video' && videoTrack) {
                                        await t.sender.replaceTrack(videoTrack);
                                    } else if (t.receiver && t.receiver.track && t.receiver.track.kind === 'audio' && systemAudioTrack) {
                                        await t.sender.replaceTrack(systemAudioTrack);
                                    }
                                }
                            }
                        }));
                        return;
                    } catch (recoverErr) {
                        console.warn("[Broadcaster] Camera recovery failed; ending broadcast:", recoverErr);
                    }
                }
                console.log("[Broadcaster] Video track ended by browser/system controls.");
                cleanupBroadcast('system_controls');
            };
        };
        bindVideoTrackEnded(videoTrack);

        // Local Preview Unification (In 'file' mode, videoElement plays the file source directly with audio)
        combinedStream = new MediaStream();
        if (videoTrack) combinedStream.addTrack(videoTrack);
        if (systemAudioTrack) combinedStream.addTrack(systemAudioTrack);
        
        console.log("Local Stream Ready for Preview");
        if (mode !== 'file') {
            videoElement.srcObject = combinedStream;
            videoElement.muted = true; // Prevent local audio feedback loop
        }

        // Notify Signaling Server
        socket.emit("broadcaster", roomId);

        // Viewer Connection Management
        socket.off("watcher");
        socket.on("watcher", async (id, username) => {
            if (!localStream || !videoTrack) return;
            console.log("Connecting to Viewer:", id, username);

            // Clean up any pre-existing connection for the same viewer ID before replacing it
            if (peerConnections[id]) {
                try {
                    peerConnections[id].oniceconnectionstatechange = null;
                    peerConnections[id].onicecandidate = null;
                    peerConnections[id].ontrack = null;
                    peerConnections[id].close();
                } catch (e) {
                    console.warn(`[Broadcaster] Error closing prior connection for ${id}:`, e);
                }
                delete peerConnections[id];
                delete pendingCandidates[id];
            }

            const peerConnection = new RTCPeerConnection(rtcConfiguration);
            peerConnections[id] = peerConnection;
            pendingCandidates[id] = [];
            const currentTotal = Object.keys(peerConnections).length;
            updateAudienceList(id, "Connecting...", "orange", username, currentTotal);

            // --- A. THREE ISOLATED TRANSCEIVERS ---
            // 1. Movie Video (sendonly)
            if (videoTrack) {
                const activeProfile = streamOptMode === 'anime' ? BITRATE_PROFILES.ANIME : BITRATE_PROFILES.HD;
                const videoTransceiver = peerConnection.addTransceiver(videoTrack, {
                    direction: 'sendonly',
                    sendEncodings: [{ maxBitrate: activeProfile.maxBitrate, scaleResolutionDownBy: activeProfile.scaleResolutionDownBy }]
                });
                try {
                    if (videoTransceiver && videoTransceiver.sender && typeof videoTransceiver.sender.getParameters === 'function') {
                        const p = videoTransceiver.sender.getParameters();
                        if (p) {
                            p.degradationPreference = activeProfile.degradationPreference;
                            videoTransceiver.sender.setParameters(p).catch(() => {});
                        }
                    }
                } catch (e) {}
            }

            // 2. Primary Programme Audio (sendonly, raw Movie Audio OR Camera Host Microphone)
            if (systemAudioTrack) {
                peerConnection.addTransceiver(systemAudioTrack, {
                    direction: 'sendonly'
                });
            }

            // 3. Voice Intercom Transceiver
            // Mode 'camera': Voice transceiver is recvonly on host (receives viewer voices, host mic is on Lane 2)
            // Mode 'screen': Voice transceiver is sendrecv (bi-directional intercom)
            if (currentMode === 'camera') {
                peerConnection.addTransceiver('audio', { direction: 'recvonly' });
            } else {
                if (hostMicTrack) {
                    peerConnection.addTransceiver(hostMicTrack, { direction: 'sendrecv' });
                } else {
                    peerConnection.addTransceiver('audio', { direction: 'sendrecv' }); 
                }
            }

            // --- B. NATIVE AEC PLAYOUT FOR VIEWER AUDIO ---
            peerConnection.ontrack = (event) => {
                const track = event.track;
                if (track.kind === 'audio') {
                    console.log(`[Audio] Receiving voice from Viewer ${id}`);
                    let viewerVoicePlayer = document.getElementById(`voice_${id}`);
                    if (!viewerVoicePlayer) {
                        viewerVoicePlayer = new Audio();
                        viewerVoicePlayer.id = `voice_${id}`;
                        viewerVoicePlayer.autoplay = true;
                        viewerVoicePlayer.playsInline = true;
                        viewerVoicePlayer.setAttribute('playsinline', '');
                        // Native AEC requirement: MUST append to DOM
                        document.body.appendChild(viewerVoicePlayer);
                    }
                    viewerVoicePlayer.srcObject = new MediaStream([track]);
                    ensureAudioElementPlays(viewerVoicePlayer, duckingController);
                    
                    // Register viewer voice with DuckingController
                    if (duckingController) {
                        duckingController.registerVoiceTrack(id, track, (isSpeaking) => {
                            setViewerSpeaking(id, isSpeaking);
                        });
                    }

                    // When Viewer unmutes mid-session via replaceTrack(), RTP packets begin flowing and 'unmute' fires
                    track.addEventListener('unmute', () => {
                        const player = document.getElementById(`voice_${id}`);
                        if (player) {
                            ensureAudioElementPlays(player, duckingController);
                        }
                        if (duckingController && duckingController.speakers) {
                            const rec = duckingController.speakers.get(id);
                            if (rec && rec.audioCtx && rec.audioCtx.state === 'suspended') {
                                rec.audioCtx.resume().catch(() => {});
                            }
                        }
                    });

                    track.addEventListener('ended', () => {
                        if (duckingController) {
                            duckingController.unregisterVoiceTrack(id);
                        }
                        const player = document.getElementById(`voice_${id}`);
                        if (player && player.parentNode) player.parentNode.removeChild(player);
                    });
                }
            };

            // --- C. FORCE VP9 CODEC PREFERENCE WITH ROBUST FALLBACKS ---
            try {
                const transceivers = peerConnection.getTransceivers();
                for (const t of transceivers) {
                    if (t.sender.track && t.sender.track.kind === 'video') {
                        const caps = RTCRtpSender.getCapabilities('video');
                        if (caps && Array.isArray(caps.codecs)) {
                            const vp9Codecs = caps.codecs.filter(c => c.mimeType && c.mimeType.toLowerCase() === 'video/vp9');
                            const otherCodecs = caps.codecs.filter(c => !c.mimeType || c.mimeType.toLowerCase() !== 'video/vp9');
                            if (vp9Codecs.length > 0) {
                                t.setCodecPreferences([...vp9Codecs, ...otherCodecs]);
                                console.log(`[Codec] Prioritized VP9 with ${otherCodecs.length} fallback codecs`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn("[Codec] VP9 preference negotiation error:", e);
            }

            // --- D. ICE HANDLING & DIRECT CONNECTION STATE ---
            peerConnection.onicecandidate = event => {
                if (event.candidate) socket.emit("candidate", id, event.candidate);
            };

            peerConnection.oniceconnectionstatechange = () => {
                // Ignore events from superseded peerConnections
                if (peerConnections[id] !== peerConnection) return;

                const state = peerConnection.iceConnectionState;
                console.log(`[ICE] Direct connection state with ${id}: ${state}`);
                const total = Object.keys(peerConnections).length;
                
                if (state === 'connected' || state === 'completed') {
                    updateAudienceList(id, "Online (Direct)", "#22c55e", username, total);
                } else if (state === 'disconnected') {
                    updateAudienceList(id, "Unstable", "#eab308", username, total);
                } else if (state === 'failed') {
                    console.warn(`[ICE] Direct connection failed with ${id}:`, getDirectConnectionDiagnostics(state));
                    updateAudienceList(id, "Failed (NAT Blocked)", "#ef4444", username, total);
                    if (duckingController) {
                        duckingController.unregisterVoiceTrack(id);
                    }
                    const voicePlayer = document.getElementById(`voice_${id}`);
                    if (voicePlayer && voicePlayer.parentNode) {
                        voicePlayer.parentNode.removeChild(voicePlayer);
                    }
                    peerConnection.close();
                    delete peerConnections[id];
                } else if (state === 'closed') {
                    if (duckingController) {
                        duckingController.unregisterVoiceTrack(id);
                    }
                    const voicePlayer = document.getElementById(`voice_${id}`);
                    if (voicePlayer && voicePlayer.parentNode) {
                        voicePlayer.parentNode.removeChild(voicePlayer);
                    }
                    peerConnection.close();
                    delete peerConnections[id];
                    removeViewerFromList(id, Object.keys(peerConnections).length);
                }
            };

            // --- E. CREATE OFFER & ENHANCE SDP ---
            try {
                const offer = await peerConnection.createOffer();

                // Scope SDP enhancement strictly to the programme-audio transceiver lane
                const enhancedSdp = enhanceBroadcasterOffer(offer.sdp, systemAudioTrack, peerConnection);

                await peerConnection.setLocalDescription({ type: 'offer', sdp: enhancedSdp });
                socket.emit("offer", id, peerConnection.localDescription);
            } catch (err) {
                console.error("Error creating offer:", err);
            }
        });

        // Signaling Event Handlers
        socket.off("answer");
        socket.on("answer", async (id, description) => {
            const pc = peerConnections[id];
            if (!pc) return;
            try {
                await pc.setRemoteDescription(description);
                const queued = pendingCandidates[id] || [];
                delete pendingCandidates[id];
                for (const cand of queued) {
                    if (peerConnections[id] === pc) {
                        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.warn("[ICE] Queued candidate error:", e));
                    }
                }
            } catch (e) {
                console.error("[WebRTC] Error setting remote answer:", e);
            }
        });

        socket.off("candidate");
        socket.on("candidate", (id, candidate) => {
            const pc = peerConnections[id];
            if (!pc || !candidate) return;
            if (pc.remoteDescription && pc.remoteDescription.type) {
                pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error(e));
            } else {
                if (!pendingCandidates[id]) pendingCandidates[id] = [];
                pendingCandidates[id].push(candidate);
            }
        });

        socket.off("disconnectPeer");
        socket.on("disconnectPeer", id => {
            console.log(`Viewer ${id} disconnected.`);
            delete pendingCandidates[id];
            if (duckingController) {
                duckingController.unregisterVoiceTrack(id);
            }
            const voicePlayer = document.getElementById(`voice_${id}`);
            if (voicePlayer && voicePlayer.parentNode) {
                voicePlayer.parentNode.removeChild(voicePlayer);
            }
            if (peerConnections[id]) {
                peerConnections[id].oniceconnectionstatechange = null;
                peerConnections[id].close();
                delete peerConnections[id];
                removeViewerFromList(id, Object.keys(peerConnections).length);
            }
        });

        // Dynamic Bitrate Adaptation
        socket.off("bitrate_request");
        socket.on("bitrate_request", async (viewerId, quality) => {
            const pc = peerConnections[viewerId];
            if (!pc) return;
            
            if (quality !== 'high' && quality !== 'low') {
                console.warn(`[Bitrate] Invalid bitrate mode requested: ${quality}`);
                return;
            }

            console.log(`[Bitrate] Setting bitrate for ${viewerId} to ${quality}`);
            const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!videoSender) return;

            try {
                const params = videoSender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }

                if (quality === 'low') {
                    params.degradationPreference = BITRATE_PROFILES.SD.degradationPreference;
                    params.encodings[0].maxBitrate = BITRATE_PROFILES.SD.maxBitrate;
                    params.encodings[0].scaleResolutionDownBy = BITRATE_PROFILES.SD.scaleResolutionDownBy; 
                } else {
                    const activeProfile = streamOptMode === 'anime' ? BITRATE_PROFILES.ANIME : BITRATE_PROFILES.HD;
                    params.degradationPreference = activeProfile.degradationPreference;
                    params.encodings[0].maxBitrate = activeProfile.maxBitrate;
                    params.encodings[0].scaleResolutionDownBy = activeProfile.scaleResolutionDownBy; 
                }

                await videoSender.setParameters(params);
                console.log(`[Bitrate] Updated sender encoding for ${viewerId}: maxBitrate=${params.encodings[0].maxBitrate}, scaleDown=${params.encodings[0].scaleResolutionDownBy}`);
            } catch (err) {
                console.error("[Bitrate] Failed to update sender parameters:", err);
            }
        });

    } catch (err) {
        if (videoTrack) {
            videoTrack.onended = null;
        }
        stopStreamTracks(localStream);
        localStream = null;
        videoTrack = null;
        systemAudioTrack = null;
        if (duckingController) {
            duckingController.destroy();
            duckingController = null;
        }
        if (err && err.reason === 'cancelled') {
            console.log("[Broadcaster] Screen capture was cancelled by the user.");
            throw err;
        }
        console.error("[Broadcaster] Broadcast initialization error:", err);
        throw err;
    }
}
