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

import { rtcConfiguration, BITRATE_PROFILES, getAdaptiveFallbackProfile, getSafeScaleResolutionDownBy, getDirectConnectionDiagnostics, getCapabilityDiagnostics } from './modules/core/config.js';
import { captureScreenWithFallback, captureCameraStream, captureVideoFileStream, stopStreamTracks, CaptureError } from './modules/media/capture.js';
import { enhanceBroadcasterOffer, setupNativeDucking, DuckingController, getAudioDiagnostics } from './modules/media/audio.js';
import { createAudienceWidget, updateAudienceList, removeViewerFromList, setViewerSpeaking, clearAudienceList } from './modules/features/audience.js';

// Global Broadcaster State
const peerConnections = {};
const pendingCandidates = {};
const viewerStates = {};
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

function clearViewerTimers(id) {
    const st = viewerStates[id];
    if (!st) return;
    if (st.handshakeTimer) {
        clearTimeout(st.handshakeTimer);
        st.handshakeTimer = null;
    }
    if (st.disconnectTimer) {
        clearTimeout(st.disconnectTimer);
        st.disconnectTimer = null;
    }
    if (st.telemetryInterval) {
        clearInterval(st.telemetryInterval);
        st.telemetryInterval = null;
    }
}

function deleteViewerState(id) {
    clearViewerTimers(id);
    delete viewerStates[id];
}

/**
 * Waits briefly (up to maxWaitMs) for local host/pooled-STUN ICE candidates to be
 * embedded into pc.localDescription.sdp while Trickle ICE also runs concurrently.
 * This ensures Same-Wi-Fi (host) and Mobile-Data/Jio (srflx) candidates arrive inside
 * the Offer SDP itself even if trickle messages experience jitter.
 */
function waitForInitialCandidates(pc, maxWaitMs = 120) {
    if (!pc || pc.iceGatheringState === 'complete') {
        return Promise.resolve();
    }
    return new Promise(resolve => {
        let settled = false;
        const done = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                pc.removeEventListener('icegatheringstatechange', onState);
                pc.removeEventListener('icecandidate', onCand);
            } catch (e) {}
            resolve();
        };
        const onState = () => {
            if (pc.iceGatheringState === 'complete') done();
        };
        const onCand = (ev) => {
            if (!ev || !ev.candidate) {
                done();
                return;
            }
            const candStr = ev.candidate.candidate || '';
            if (candStr.includes('typ srflx')) {
                // Once at least one server-reflexive candidate is gathered alongside host candidates, resolve after a tiny 15ms batch window
                setTimeout(done, 15);
            }
        };
        const timer = setTimeout(done, maxWaitMs);
        try {
            pc.addEventListener('icegatheringstatechange', onState);
            pc.addEventListener('icecandidate', onCand);
        } catch (e) {
            done();
        }
    });
}

function isIOSWebKitHost() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod|CriOS|FxiOS|EdgiOS/i.test(ua)) return true;
    if (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1) return true;
    return false;
}

function configureVideoCodecs(peerConnection, preferHardwareFallback = false, codecFallbackStep = 0) {
    if (!peerConnection || typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') {
        return;
    }
    try {
        const caps = RTCRtpSender.getCapabilities('video');
        if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) return;

        const vp9Profile0Codecs = [];
        const baselineH264Codecs = [];
        const otherH264Codecs = [];
        const vp8Codecs = [];
        const otherCodecs = [];

        for (const c of caps.codecs) {
            const mime = (c.mimeType || '').toLowerCase();
            const fmtp = (c.sdpFmtpLine || '').toLowerCase();
            if (mime === 'video/vp9') {
                // Exclude 10-bit/HDR VP9 profiles (profile-id=1, 2, 3) which cause black screens
                // on mobile hardware decoders (such as Google Pixel Tensor c2.exynos.vp9.decoder)
                if (!fmtp.includes('profile-id=') || fmtp.includes('profile-id=0')) {
                    vp9Profile0Codecs.push(c);
                }
            } else if (mime === 'video/h264') {
                // Prefer Constrained Baseline / Baseline (42e01f, 42001f, 42801f) over High/Main profiles for mobile compatibility
                if (fmtp.includes('42e0') || fmtp.includes('4200') || fmtp.includes('4280')) {
                    baselineH264Codecs.push(c);
                } else {
                    otherH264Codecs.push(c);
                }
            } else if (mime === 'video/vp8') {
                vp8Codecs.push(c);
            } else {
                otherCodecs.push(c);
            }
        }

        const h264Ordered = [...baselineH264Codecs, ...otherH264Codecs];
        const iosHost = isIOSWebKitHost();
        let orderedCodecs;
        if ((codecFallbackStep % 3) === 1) {
            // Step 1: Hardware Constrained Baseline H264 first (or VP8 if Host is iOS stepping from H264), then 8-bit VP9
            orderedCodecs = iosHost
                ? [...vp8Codecs, ...h264Ordered, ...vp9Profile0Codecs, ...otherCodecs]
                : [...h264Ordered, ...vp8Codecs, ...vp9Profile0Codecs, ...otherCodecs];
        } else if (!preferHardwareFallback && (codecFallbackStep % 3) === 2) {
            // Step 2: 8-bit VP9 Profile 0 first, then VP8, then Constrained Baseline H264
            orderedCodecs = [...vp9Profile0Codecs, ...vp8Codecs, ...h264Ordered, ...otherCodecs];
        } else if (iosHost) {
            // iOS / iPadOS Host (Safari & Chrome CriOS): Prioritize Apple VideoToolbox Constrained Baseline H264 first, then VP8
            orderedCodecs = [...h264Ordered, ...vp8Codecs, ...vp9Profile0Codecs, ...otherCodecs];
        } else {
            // Default (Step 0) & Hardware Fallback: Universal VP8 first, then Constrained Baseline H264, then 8-bit VP9
            // Prevents Google Pixel Tensor (c2.exynos.vp9.decoder) & mobile hardware VP9 black screens from Frame 1
            orderedCodecs = [...vp8Codecs, ...h264Ordered, ...vp9Profile0Codecs, ...otherCodecs];
        }

        if (orderedCodecs.length === 0) return;

        const transceivers = peerConnection.getTransceivers();
        for (const t of transceivers) {
            if (t.sender && t.sender.track && t.sender.track.kind === 'video' && typeof t.setCodecPreferences === 'function') {
                t.setCodecPreferences(orderedCodecs);
            }
        }
    } catch (e) {
        console.warn("[Codec] Codec preference negotiation warning:", e);
    }
}

async function applyViewerEncodingProfile(id, pc) {
    const targetPc = pc || peerConnections[id];
    const st = viewerStates[id];
    if (!targetPc || !st) return null;

    const videoSender = targetPc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (!videoSender || typeof videoSender.getParameters !== 'function' || typeof videoSender.setParameters !== 'function') {
        return null;
    }

    const effectiveTier = st.manualQuality === 'low' ? Math.max(st.fallbackTier, 2) : st.fallbackTier;
    const profile = getAdaptiveFallbackProfile(effectiveTier, streamOptMode);
    const trackSettings = (videoSender.track && typeof videoSender.track.getSettings === 'function')
        ? videoSender.track.getSettings()
        : null;
    const safeScale = getSafeScaleResolutionDownBy(profile.scaleResolutionDownBy, trackSettings);

    try {
        const params = videoSender.getParameters() || {};
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
        }
        params.degradationPreference = profile.degradationPreference;
        params.encodings[0].maxBitrate = profile.maxBitrate;
        params.encodings[0].scaleResolutionDownBy = safeScale;
        if (profile.maxFramerate) {
            params.encodings[0].maxFramerate = profile.maxFramerate;
        }
        await videoSender.setParameters(params);
        console.log(`[AdaptiveFallback] Viewer ${id} set to ${profile.label} (tier ${effectiveTier}): maxBitrate=${profile.maxBitrate}, scaleDown=${safeScale}`);
        return profile;
    } catch (e) {
        console.warn(`[AdaptiveFallback] Could not update sender parameters for ${id}:`, e);
        return null;
    }
}

function ensureAudioElementPlays(audioEl, duckCtrl) {
    if (!audioEl) return;
    audioEl.muted = false;
    if (typeof audioEl.volume === 'number' && audioEl.volume === 0) {
        audioEl.volume = 1.0;
    }
    if (duckCtrl && typeof duckCtrl.resumeContext === 'function') {
        duckCtrl.resumeContext();
    }
    const playPromise = audioEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
            console.warn("[Audio] Voice playout deferred by browser policy; binding interaction unlock:", err);
            const unlock = () => {
                audioEl.muted = false;
                audioEl.play().catch(() => {});
                if (duckCtrl && typeof duckCtrl.resumeContext === 'function') {
                    duckCtrl.resumeContext();
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

function claimOrCreateVoicePlayer(playerId) {
    let player = document.getElementById(playerId);
    if (player) return player;
    if (typeof window !== 'undefined' && Array.isArray(window._blessedVoicePlayers) && window._blessedVoicePlayers.length > 0) {
        player = window._blessedVoicePlayers.pop();
    }
    if (!player) {
        player = new Audio();
    }
    player.id = playerId;
    player.autoplay = true;
    player.playsInline = true;
    player.muted = false;
    player.volume = 1.0;
    player.setAttribute('playsinline', '');
    player.setAttribute('webkit-playsinline', '');
    if (!player.parentNode && document.body) {
        document.body.appendChild(player);
    }
    return player;
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
    duckingController.resumeContext();

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
        socket.off("intercom-state");
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
            deleteViewerState(id);
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
        Object.keys(viewerStates).forEach(id => deleteViewerState(id));
        Object.keys(pendingCandidates).forEach(id => delete pendingCandidates[id]);
        window.flipHostCamera = null;
        window.setStreamOptimizationMode = null;
        window.toggleHostMic = null;

        if (typeof onEnded === 'function') {
            onEnded(reason);
        }
    };

    window.stopBroadcast = cleanupBroadcast;
    window.broadcaster = {
        get peerConnections() { return peerConnections; },
        get viewerStates() { return viewerStates; },
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
        await Promise.all(Object.keys(peerConnections).map(async id => {
            await applyViewerEncodingProfile(id, peerConnections[id]);
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

            // Live Camera Flip Handler (Front <-> Rear for iPad, iPhone, Android, and multi-cam desktops)
            window.flipHostCamera = async () => {
                if (currentMode !== 'camera' || !localStream || isFlippingCamera) return null;
                isFlippingCamera = true;
                const nextFacing = currentFacingMode === 'user' ? 'environment' : 'user';
                try {
                    let newCamStream = null;
                    try {
                        newCamStream = await captureCameraStream({ facingMode: nextFacing, audio: false });
                    } catch (dualOpenErr) {
                        // iOS / iPadOS AVFoundation exclusive camera lock: only one sensor can be active at a time.
                        // Release the current videoTrack first, then request the opposite sensor.
                        console.warn("[Broadcaster] Exclusive camera lock detected (iOS/iPadOS); releasing current sensor before switching...", dualOpenErr);
                        if (videoTrack) {
                            videoTrack.onended = null;
                            try { videoTrack.stop(); } catch (e) {}
                            if (localStream && typeof localStream.removeTrack === 'function') {
                                localStream.removeTrack(videoTrack);
                            }
                            videoTrack = null;
                        }
                        try {
                            newCamStream = await captureCameraStream({ facingMode: nextFacing, audio: false });
                        } catch (reopenErr) {
                            // Device only has a single camera; restore previous facingMode so broadcast never drops
                            const restoredStream = await captureCameraStream({ facingMode: currentFacingMode, audio: false }).catch(() => null);
                            if (restoredStream && restoredStream.getVideoTracks()[0]) {
                                const restoredTrack = restoredStream.getVideoTracks()[0];
                                if (localStream && typeof localStream.addTrack === 'function') localStream.addTrack(restoredTrack);
                                videoTrack = restoredTrack;
                                bindVideoTrackEnded(videoTrack);
                                await Promise.all(Object.values(peerConnections).map(async pc => {
                                    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
                                    if (videoSender) await videoSender.replaceTrack(videoTrack);
                                }));
                            }
                            throw reopenErr;
                        }
                    }
                    const newVideoTrack = newCamStream ? newCamStream.getVideoTracks()[0] : null;
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

                        // Inject into existing active peer connections dynamically via replaceTrack + in-place SDP sync
                        if (duckingController) {
                            duckingController.resumeContext();
                        }
                        const replacePromises = Object.entries(peerConnections).map(async ([viewerId, pc]) => {
                            const voiceTransceiver = pc._intercomTransceiver || pc.getTransceivers().find(
                                t => t.direction === 'sendrecv' || t.currentDirection === 'sendrecv'
                            );
                            if (voiceTransceiver && voiceTransceiver.sender) {
                                voiceTransceiver.direction = 'sendrecv';
                                await voiceTransceiver.sender.replaceTrack(hostMicTrack);
                            }
                            socket.emit("intercom-state", viewerId, { active: true });
                            if (typeof window._renegotiateIntercomWithViewer === 'function') {
                                await window._renegotiateIntercomWithViewer(viewerId);
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

                        const clearPromises = Object.entries(peerConnections).map(async ([viewerId, pc]) => {
                            const voiceTransceiver = pc._intercomTransceiver || pc.getTransceivers().find(
                                t => t.direction === 'sendrecv' || t.currentDirection === 'sendrecv'
                            );
                            if (voiceTransceiver && voiceTransceiver.sender) {
                                await voiceTransceiver.sender.replaceTrack(null);
                            }
                            socket.emit("intercom-state", viewerId, { active: false });
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
                if (currentMode === 'file') {
                    console.log("[Broadcaster] Video file playback ended; keeping room active for replay or seek.");
                    return;
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

        const performIceRestart = async (id, reason = 'recovery') => {
            const pc = peerConnections[id];
            const st = viewerStates[id];
            if (!pc || !st || pc.signalingState === 'closed' || pc.iceConnectionState === 'closed') {
                return false;
            }
            console.log(`[ICE] Triggering ICE restart & fallback negotiation for ${id} (reason: ${reason}, attempt: ${st.iceRestartCount}, tier: ${st.fallbackTier}, signaling: ${pc.signalingState})`);

            await applyViewerEncodingProfile(id, pc);

            // If still waiting for the initial answer ('have-local-offer'), wait briefly for gathered candidates
            // and re-emit localDescription which now contains all pre-gathered STUN/host ICE candidates in its SDP.
            if (pc.signalingState === 'have-local-offer' && pc.localDescription) {
                await waitForInitialCandidates(pc, 120);
                if (peerConnections[id] !== pc) return false;
                socket.emit("offer", id, pc.localDescription);
                return true;
            }

            if (pc.signalingState !== 'stable') {
                return false;
            }

            const restartGen = ++st.generation;
            st.codecFallbackStep = (st.codecFallbackStep || 0) + 1;
            configureVideoCodecs(pc, st.fallbackTier >= 1 || st.iceRestartCount > 0, st.codecFallbackStep);

            try {
                if (typeof pc.restartIce === 'function') {
                    pc.restartIce();
                }
                const offer = await pc.createOffer({ iceRestart: true });
                if (peerConnections[id] !== pc || !viewerStates[id] || viewerStates[id].generation !== restartGen) {
                    return false;
                }
                const enhancedSdp = enhanceBroadcasterOffer(offer.sdp, systemAudioTrack, pc);
                await pc.setLocalDescription({ type: 'offer', sdp: enhancedSdp });
                if (peerConnections[id] !== pc || !viewerStates[id] || viewerStates[id].generation !== restartGen) {
                    return false;
                }
                await waitForInitialCandidates(pc, 100);
                if (peerConnections[id] !== pc || !viewerStates[id] || viewerStates[id].generation !== restartGen) {
                    return false;
                }
                socket.emit("offer", id, pc.localDescription);
                return true;
            } catch (err) {
                console.warn(`[ICE] ICE restart offer failed for ${id}:`, err);
                return false;
            }
        };
        if (window.broadcaster) {
            window.broadcaster.restartIce = performIceRestart;
        }

        const renegotiateIntercomWithViewer = async (id) => {
            const pc = peerConnections[id];
            const st = viewerStates[id];
            if (!pc || !st || pc.signalingState === 'closed' || pc.iceConnectionState === 'closed' || pc.iceConnectionState === 'failed') {
                return false;
            }
            if (pc.signalingState !== 'stable') {
                st.pendingIntercomRenegotiate = true;
                return false;
            }
            st.pendingIntercomRenegotiate = false;
            const regen = ++st.generation;
            try {
                const offer = await pc.createOffer();
                if (peerConnections[id] !== pc || !viewerStates[id] || viewerStates[id].generation !== regen) {
                    return false;
                }
                const enhancedSdp = enhanceBroadcasterOffer(offer.sdp, systemAudioTrack, pc);
                await pc.setLocalDescription({ type: 'offer', sdp: enhancedSdp });
                if (peerConnections[id] !== pc || !viewerStates[id] || viewerStates[id].generation !== regen) {
                    return false;
                }
                socket.emit("offer", id, pc.localDescription);
                return true;
            } catch (err) {
                console.warn(`[Intercom] In-place renegotiation warning for ${id}:`, err);
                return false;
            }
        };
        window._renegotiateIntercomWithViewer = renegotiateIntercomWithViewer;

        const bindViewerVoiceTrack = (id, track, { forceRefresh = false } = {}) => {
            if (!track || track.kind !== 'audio') return;
            const viewerVoicePlayer = claimOrCreateVoicePlayer(`voice_${id}`);
            const currentTracks = (viewerVoicePlayer.srcObject && typeof viewerVoicePlayer.srcObject.getTracks === 'function')
                ? viewerVoicePlayer.srcObject.getTracks()
                : [];
            if (forceRefresh || !currentTracks.includes(track) || viewerVoicePlayer.paused) {
                viewerVoicePlayer.srcObject = new MediaStream([track]);
            }
            ensureAudioElementPlays(viewerVoicePlayer, duckingController);

            if (duckingController) {
                duckingController.registerVoiceTrack(id, track, (isSpeaking) => {
                    setViewerSpeaking(id, isSpeaking);
                }, viewerVoicePlayer);
            }

            if (!track._streamyBound) {
                track._streamyBound = true;
                track.addEventListener('unmute', () => {
                    bindViewerVoiceTrack(id, track, { forceRefresh: true });
                });
                track.addEventListener('ended', () => {
                    if (duckingController) {
                        duckingController.unregisterVoiceTrack(id, track);
                    }
                    const player = document.getElementById(`voice_${id}`);
                    if (player && player.srcObject && typeof player.srcObject.getTracks === 'function') {
                        if (!player.srcObject.getTracks().includes(track)) return;
                    }
                    if (player && player.parentNode) player.parentNode.removeChild(player);
                });
            }
        };

        const startViewerTelemetry = (id, pc) => {
            const st = viewerStates[id];
            if (!st || !pc) return;
            if (st.telemetryInterval) {
                clearInterval(st.telemetryInterval);
            }
            st.telemetryInterval = setInterval(async () => {
                if (peerConnections[id] !== pc || !viewerStates[id]) {
                    clearViewerTimers(id);
                    return;
                }
                const iceState = pc.iceConnectionState;
                if (iceState !== 'connected' && iceState !== 'completed') return;
                if (typeof pc.getStats !== 'function') return;

                try {
                    const stats = await pc.getStats();
                    if (peerConnections[id] !== pc || !viewerStates[id]) return;

                    let packetsSent = 0;
                    let packetsLost = 0;
                    let rtt = 0;
                    let qualityLimitation = 'none';

                    stats.forEach(report => {
                        if (report.type === 'outbound-rtp' && report.kind === 'video') {
                            packetsSent = report.packetsSent || 0;
                            if (report.qualityLimitationReason) {
                                qualityLimitation = report.qualityLimitationReason;
                            }
                        } else if (report.type === 'remote-inbound-rtp' && report.kind === 'video') {
                            packetsLost = report.packetsLost || 0;
                            if (typeof report.roundTripTime === 'number') {
                                rtt = report.roundTripTime;
                            }
                        } else if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                            if (typeof report.currentRoundTripTime === 'number' && rtt === 0) {
                                rtt = report.currentRoundTripTime;
                            }
                        }
                    });

                    const prev = st.lastStats;
                    st.lastStats = { packetsSent, packetsLost, timestamp: Date.now() };

                    let lossRatio = 0;
                    if (prev && packetsSent > prev.packetsSent) {
                        const sentDelta = packetsSent - prev.packetsSent;
                        const lostDelta = Math.max(0, packetsLost - prev.packetsLost);
                        if (sentDelta + lostDelta > 10) {
                            lossRatio = lostDelta / (sentDelta + lostDelta);
                        }
                    }

                    const isDegraded = lossRatio > 0.05 || rtt > 0.35 || qualityLimitation === 'bandwidth' || qualityLimitation === 'cpu';
                    const isHealthy = lossRatio < 0.01 && rtt < 0.20 && qualityLimitation === 'none';

                    if (isDegraded) {
                        st.consecutiveGoodChecks = 0;
                        if (st.fallbackTier < 3) {
                            st.fallbackTier = Math.min(3, st.fallbackTier + 1);
                            console.warn(`[AdaptiveFallback] Network congestion detected for ${id} (loss=${(lossRatio * 100).toFixed(1)}%, rtt=${Math.round(rtt * 1000)}ms, limit=${qualityLimitation}). Stepping down to tier ${st.fallbackTier}.`);
                            await applyViewerEncodingProfile(id, pc);
                        }
                    } else if (isHealthy) {
                        st.consecutiveGoodChecks = (st.consecutiveGoodChecks || 0) + 1;
                        if (st.consecutiveGoodChecks >= 5 && st.fallbackTier > 0 && st.manualQuality !== 'low') {
                            st.fallbackTier = Math.max(0, st.fallbackTier - 1);
                            st.consecutiveGoodChecks = 0;
                            console.log(`[AdaptiveFallback] Sustained healthy link for ${id}. Stepping quality up to tier ${st.fallbackTier}.`);
                            await applyViewerEncodingProfile(id, pc);
                        }
                    }
                } catch (e) {
                    // Ignore transient getStats errors
                }
            }, 2500);
        };

        // Notify Signaling Server
        socket.emit("broadcaster", roomId);

        // Viewer Connection Management
        socket.off("watcher");
        socket.on("watcher", async (id, username) => {
            if (!localStream || !videoTrack) return;
            console.log("Connecting to Viewer:", id, username);

            const prevState = viewerStates[id];
            const nextGen = ((prevState && prevState.generation) || 0) + 1;
            const preservedManualQuality = (prevState && prevState.manualQuality) || 'high';
            // Distinguish a real post-answer/timeout recovery retry from the initial click on "JOIN MOVIE" after pre-curtain join-room
            const isRecoveryRetry = Boolean(prevState && (prevState.hasAnswered || prevState.iceRestartCount > 0 || prevState.manualQuality === 'low'));
            const nextCodecStep = isRecoveryRetry ? ((prevState && prevState.codecFallbackStep) || 0) + 1 : 0;
            const initialFallbackTier = isRecoveryRetry
                ? Math.min(3, Math.max((prevState && prevState.fallbackTier) || 0, 2))
                : 0;

            clearViewerTimers(id);
            viewerStates[id] = {
                generation: nextGen,
                username: username || (prevState && prevState.username) || 'Viewer',
                manualQuality: preservedManualQuality,
                fallbackTier: initialFallbackTier,
                codecFallbackStep: nextCodecStep,
                hasAnswered: false,
                iceRestartCount: 0,
                handshakeTimer: null,
                disconnectTimer: null,
                telemetryInterval: null,
                lastStats: null,
                consecutiveGoodChecks: 0
            };

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
            const displayUsername = viewerStates[id].username;
            updateAudienceList(id, "Connecting...", "orange", displayUsername, currentTotal);

            // --- A. THREE ISOLATED TRANSCEIVERS ---
            // 1. Movie Video (sendonly)
            if (videoTrack) {
                const effectiveInitTier = preservedManualQuality === 'low' ? Math.max(initialFallbackTier, 2) : initialFallbackTier;
                const activeProfile = getAdaptiveFallbackProfile(effectiveInitTier, streamOptMode);
                const trackSettings = typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : null;
                const safeScale = getSafeScaleResolutionDownBy(activeProfile.scaleResolutionDownBy, trackSettings);
                const encodingInit = {
                    maxBitrate: activeProfile.maxBitrate,
                    scaleResolutionDownBy: safeScale
                };
                if (activeProfile.maxFramerate) {
                    encodingInit.maxFramerate = activeProfile.maxFramerate;
                }
                const videoTransceiver = peerConnection.addTransceiver(videoTrack, {
                    direction: 'sendonly',
                    sendEncodings: [encodingInit]
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
                peerConnection._intercomTransceiver = peerConnection.addTransceiver('audio', { direction: 'recvonly' });
            } else {
                if (hostMicTrack) {
                    peerConnection._intercomTransceiver = peerConnection.addTransceiver(hostMicTrack, { direction: 'sendrecv' });
                } else {
                    peerConnection._intercomTransceiver = peerConnection.addTransceiver('audio', { direction: 'sendrecv' }); 
                }
            }

            // --- B. NATIVE AEC PLAYOUT FOR VIEWER AUDIO ---
            peerConnection.ontrack = (event) => {
                const track = event.track;
                if (track.kind === 'audio') {
                    console.log(`[Audio] Receiving voice from Viewer ${id}`);
                    bindViewerVoiceTrack(id, track);
                }
            };

            // --- C. CONFIGURE SAFE CODEC PREFERENCES WITH HARDWARE/VP8 FALLBACKS ---
            configureVideoCodecs(peerConnection, initialFallbackTier >= 1 || isRecoveryRetry, nextCodecStep);

            // --- D. ICE HANDLING, WATCHDOGS & SELF-HEALING STATE ---
            peerConnection.onicecandidate = event => {
                if (peerConnections[id] !== peerConnection) return;
                if (event.candidate) socket.emit("candidate", id, event.candidate);
            };

            // Handshake Watchdog: if stuck in "Connecting..." ('new' or 'checking') on mobile, step down & restart ICE
            const armHandshakeWatchdog = () => {
                if (!viewerStates[id]) return;
                if (viewerStates[id].handshakeTimer) clearTimeout(viewerStates[id].handshakeTimer);
                viewerStates[id].handshakeTimer = setTimeout(async () => {
                    if (peerConnections[id] !== peerConnection || !viewerStates[id]) return;
                    const st = viewerStates[id];
                    const iceState = peerConnection.iceConnectionState;
                    if (iceState === 'new' || iceState === 'checking') {
                        // If viewer is still on the JOIN MOVIE curtain (hasn't answered yet), re-emit offer with gathered candidates without burning retries
                        if (!st.hasAnswered && peerConnection.signalingState === 'have-local-offer' && peerConnection.localDescription) {
                            socket.emit("offer", id, peerConnection.localDescription);
                            armHandshakeWatchdog();
                            return;
                        }
                        console.warn(`[ICE] Handshake watchdog triggered for ${id} (state: ${iceState}). Stepping down bitrate and restarting ICE...`);
                        st.fallbackTier = Math.max(st.fallbackTier, 2); // SD 800 kbps for fast mobile lock
                        st.iceRestartCount++;
                        await performIceRestart(id, 'handshake_watchdog');
                    }
                }, 5500);
            };
            armHandshakeWatchdog();

            peerConnection.oniceconnectionstatechange = () => {
                // Ignore events from superseded peerConnections
                if (peerConnections[id] !== peerConnection) return;

                const state = peerConnection.iceConnectionState;
                const st = viewerStates[id];
                const viewerName = (st && st.username) || username;
                console.log(`[ICE] Direct connection state with ${id}: ${state}`);
                const total = Object.keys(peerConnections).length;
                
                if (state === 'connected' || state === 'completed') {
                    if (st) {
                        if (st.handshakeTimer) {
                            clearTimeout(st.handshakeTimer);
                            st.handshakeTimer = null;
                        }
                        if (st.disconnectTimer) {
                            clearTimeout(st.disconnectTimer);
                            st.disconnectTimer = null;
                        }
                        st.iceRestartCount = 0;
                    }
                    updateAudienceList(id, "Online (Direct)", "#22c55e", viewerName, total);
                    startViewerTelemetry(id, peerConnection);
                } else if (state === 'disconnected') {
                    updateAudienceList(id, "Unstable", "#eab308", viewerName, total);
                    if (st) {
                        if (st.telemetryInterval) {
                            clearInterval(st.telemetryInterval);
                            st.telemetryInterval = null;
                        }
                        // Immediately step down bitrate to relieve wireless/mobile UDP buffer congestion
                        st.fallbackTier = Math.min(3, Math.max((st.fallbackTier || 0) + 1, 2));
                        applyViewerEncodingProfile(id, peerConnection);

                        if (st.disconnectTimer) clearTimeout(st.disconnectTimer);
                        st.disconnectTimer = setTimeout(async () => {
                            if (peerConnections[id] !== peerConnection || !viewerStates[id]) return;
                            if (peerConnection.iceConnectionState === 'disconnected' && st.iceRestartCount < 3) {
                                st.iceRestartCount++;
                                await performIceRestart(id, 'unstable_disconnected');
                            }
                        }, 2800);
                    }
                } else if (state === 'failed') {
                    if (st && st.iceRestartCount < 2) {
                        clearViewerTimers(id);
                        st.iceRestartCount++;
                        st.fallbackTier = 3; // Emergency 450 kbps @ 24fps fallback
                        updateAudienceList(id, "Unstable", "#eab308", viewerName, total);
                        performIceRestart(id, 'failed_recovery');
                        st.disconnectTimer = setTimeout(() => {
                            if (peerConnections[id] !== peerConnection) return;
                            if (peerConnection.iceConnectionState === 'failed' || peerConnection.iceConnectionState === 'disconnected') {
                                console.warn(`[ICE] Direct connection recovery exhausted with ${id}:`, getDirectConnectionDiagnostics('failed'));
                                updateAudienceList(id, "Failed (NAT Blocked)", "#ef4444", viewerName, Object.keys(peerConnections).length);
                                if (duckingController) {
                                    duckingController.unregisterVoiceTrack(id);
                                }
                                const voicePlayer = document.getElementById(`voice_${id}`);
                                if (voicePlayer && voicePlayer.parentNode) {
                                    voicePlayer.parentNode.removeChild(voicePlayer);
                                }
                                deleteViewerState(id);
                                peerConnection.close();
                                delete peerConnections[id];
                            }
                        }, 6000);
                        return;
                    }

                    console.warn(`[ICE] Direct connection failed with ${id}:`, getDirectConnectionDiagnostics(state));
                    updateAudienceList(id, "Failed (NAT Blocked)", "#ef4444", viewerName, total);
                    if (duckingController) {
                        duckingController.unregisterVoiceTrack(id);
                    }
                    const voicePlayer = document.getElementById(`voice_${id}`);
                    if (voicePlayer && voicePlayer.parentNode) {
                        voicePlayer.parentNode.removeChild(voicePlayer);
                    }
                    deleteViewerState(id);
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
                    deleteViewerState(id);
                    peerConnection.close();
                    delete peerConnections[id];
                    removeViewerFromList(id, Object.keys(peerConnections).length);
                }
            };

            // --- E. CREATE OFFER & ENHANCE SDP (Generation-Guarded + Embedded Candidates) ---
            try {
                const offer = await peerConnection.createOffer();
                if (peerConnections[id] !== peerConnection || !viewerStates[id] || viewerStates[id].generation !== nextGen) {
                    return;
                }

                // Scope SDP enhancement strictly to the programme-audio transceiver lane
                const enhancedSdp = enhanceBroadcasterOffer(offer.sdp, systemAudioTrack, peerConnection);

                await peerConnection.setLocalDescription({ type: 'offer', sdp: enhancedSdp });
                if (peerConnections[id] !== peerConnection || !viewerStates[id] || viewerStates[id].generation !== nextGen) {
                    return;
                }
                // Wait briefly (up to 120ms) so pooled LAN host & STUN srflx candidates are embedded in the Offer SDP itself
                await waitForInitialCandidates(peerConnection, 120);
                if (peerConnections[id] !== peerConnection || !viewerStates[id] || viewerStates[id].generation !== nextGen) {
                    return;
                }
                socket.emit("offer", id, peerConnection.localDescription);
            } catch (err) {
                console.error("Error creating offer:", err);
            }
        });

        // Signaling Event Handlers
        socket.off("answer");
        socket.on("answer", async (id, description) => {
            const pc = peerConnections[id];
            if (!pc || !description) return;
            if (pc.signalingState !== 'have-local-offer') {
                console.warn(`[WebRTC] Ignoring stale answer from ${id} in signalingState=${pc.signalingState}`);
                return;
            }
            if (viewerStates[id]) {
                viewerStates[id].hasAnswered = true;
            }
            try {
                await pc.setRemoteDescription(description);
                const intercomTransceiver = pc._intercomTransceiver || pc.getTransceivers().find(
                    t => t.direction === 'sendrecv' || t.direction === 'recvonly' ||
                         t.currentDirection === 'sendrecv' || t.currentDirection === 'recvonly'
                );
                if (intercomTransceiver && intercomTransceiver.receiver && intercomTransceiver.receiver.track) {
                    bindViewerVoiceTrack(id, intercomTransceiver.receiver.track);
                }
                const queued = pendingCandidates[id] || [];
                delete pendingCandidates[id];
                for (const cand of queued) {
                    if (peerConnections[id] === pc && cand && cand.candidate) {
                        await pc.addIceCandidate(new RTCIceCandidate(cand)).catch(e => console.warn("[ICE] Queued candidate error:", e));
                    }
                }
                if (viewerStates[id] && viewerStates[id].pendingIntercomRenegotiate && pc.signalingState === 'stable') {
                    viewerStates[id].pendingIntercomRenegotiate = false;
                    await renegotiateIntercomWithViewer(id);
                }
            } catch (e) {
                console.error("[WebRTC] Error setting remote answer:", e);
            }
        });

        socket.off("candidate");
        socket.on("candidate", (id, candidate) => {
            const pc = peerConnections[id];
            if (!pc || !candidate) return;
            if (typeof candidate.candidate === 'string' && candidate.candidate.trim() === '') return;
            if (pc.remoteDescription && pc.remoteDescription.type && pc.signalingState === 'stable') {
                pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn("[ICE] Candidate warning:", e));
            } else {
                if (!pendingCandidates[id]) pendingCandidates[id] = [];
                pendingCandidates[id].push(candidate);
            }
        });

        socket.off("intercom-state");
        socket.on("intercom-state", async (viewerId, payload) => {
            const pc = peerConnections[viewerId];
            if (!pc || !payload) return;
            if (duckingController) {
                duckingController.resumeContext();
            }
            const intercomTransceiver = pc._intercomTransceiver || pc.getTransceivers().find(
                t => t.direction === 'sendrecv' || t.direction === 'recvonly' ||
                     t.currentDirection === 'sendrecv' || t.currentDirection === 'recvonly'
            );
            if (payload.active) {
                if (intercomTransceiver && intercomTransceiver.receiver && intercomTransceiver.receiver.track) {
                    bindViewerVoiceTrack(viewerId, intercomTransceiver.receiver.track, { forceRefresh: true });
                }
                if (pc.signalingState === 'stable') {
                    await renegotiateIntercomWithViewer(viewerId);
                } else if (viewerStates[viewerId]) {
                    viewerStates[viewerId].pendingIntercomRenegotiate = true;
                }
            } else {
                setViewerSpeaking(viewerId, false);
            }
        });

        socket.off("disconnectPeer");
        socket.on("disconnectPeer", id => {
            console.log(`Viewer ${id} disconnected.`);
            delete pendingCandidates[id];
            deleteViewerState(id);
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
            if (!viewerStates[viewerId]) {
                viewerStates[viewerId] = {
                    generation: 1,
                    username: 'Viewer',
                    manualQuality: quality,
                    fallbackTier: quality === 'low' ? 2 : 0,
                    codecFallbackStep: quality === 'low' ? 1 : 0,
                    hasAnswered: true,
                    iceRestartCount: 0,
                    handshakeTimer: null,
                    disconnectTimer: null,
                    telemetryInterval: null,
                    lastStats: null,
                    consecutiveGoodChecks: 0
                };
            } else {
                viewerStates[viewerId].manualQuality = quality;
                if (quality === 'low') {
                    viewerStates[viewerId].fallbackTier = Math.max(viewerStates[viewerId].fallbackTier || 0, 2);
                } else {
                    viewerStates[viewerId].fallbackTier = 0;
                    viewerStates[viewerId].consecutiveGoodChecks = 0;
                }
            }

            await applyViewerEncodingProfile(viewerId, pc);
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
