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
let offerGeneration = 0;
let isApplyingOffer = false;
let forceFreshPeerConnection = false;
let blackScreenRecoveryCount = 0;
let viewerHandshakeTimer = null;
let viewerRecoveryTimer = null;
let viewerHealthInterval = null;
let viewerReconnectTimer = null;
let viewerRetryCount = 0;

function isMobileOrTouchViewer() {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    if (/Android|Pixel|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
    if (typeof window !== 'undefined' && window.innerWidth <= 900 && navigator.maxTouchPoints > 0) return true;
    return false;
}

function waitForInitialCandidates(pc, maxWaitMs = 100) {
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

function configureViewerVideoCodecs(videoTransceiver, preferUniversalFallback = false, codecStep = 0) {
    if (!videoTransceiver || typeof videoTransceiver.setCodecPreferences !== 'function') return;
    if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') return;
    try {
        const caps = RTCRtpReceiver.getCapabilities('video');
        if (!caps || !Array.isArray(caps.codecs) || caps.codecs.length === 0) return;

        const vp8Codecs = [];
        const baselineH264Codecs = [];
        const otherH264Codecs = [];
        const vp9Profile0Codecs = [];
        const otherCodecs = [];

        for (const c of caps.codecs) {
            const mime = (c.mimeType || '').toLowerCase();
            const fmtp = (c.sdpFmtpLine || '').toLowerCase();
            if (mime === 'video/vp8') {
                vp8Codecs.push(c);
            } else if (mime === 'video/h264') {
                if (fmtp.includes('42e0') || fmtp.includes('4200') || fmtp.includes('4280')) {
                    baselineH264Codecs.push(c);
                } else {
                    otherH264Codecs.push(c);
                }
            } else if (mime === 'video/vp9') {
                if (!fmtp.includes('profile-id=') || fmtp.includes('profile-id=0')) {
                    vp9Profile0Codecs.push(c);
                }
            } else {
                otherCodecs.push(c);
            }
        }

        const h264Ordered = [...baselineH264Codecs, ...otherH264Codecs];
        let ordered;
        if (preferUniversalFallback || (codecStep % 3) === 1) {
            // Mobile / Pixel / Fallback Step 1: Universal VP8 first, then Constrained Baseline H264, then 8-bit VP9
            ordered = [...vp8Codecs, ...h264Ordered, ...vp9Profile0Codecs, ...otherCodecs];
        } else if ((codecStep % 3) === 2) {
            // Fallback Step 2: Constrained Baseline H264 first, then VP8, then 8-bit VP9
            ordered = [...h264Ordered, ...vp8Codecs, ...vp9Profile0Codecs, ...otherCodecs];
        } else {
            ordered = [...vp9Profile0Codecs, ...vp8Codecs, ...h264Ordered, ...otherCodecs];
        }

        if (ordered.length > 0) {
            videoTransceiver.setCodecPreferences(ordered);
        }
    } catch (e) {
        console.warn("[Codec] Viewer codec preference warning:", e);
    }
}

function clearViewerWatchdogs() {
    if (viewerHandshakeTimer) {
        clearTimeout(viewerHandshakeTimer);
        viewerHandshakeTimer = null;
    }
    if (viewerRecoveryTimer) {
        clearTimeout(viewerRecoveryTimer);
        viewerRecoveryTimer = null;
    }
    if (viewerHealthInterval) {
        clearInterval(viewerHealthInterval);
        viewerHealthInterval = null;
    }
    if (viewerReconnectTimer) {
        clearTimeout(viewerReconnectTimer);
        viewerReconnectTimer = null;
    }
}

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
    window.viewer = {
        get peerConnection() { return peerConnection; },
        get isHighQuality() { return isHighQuality; },
        get retryCount() { return viewerRetryCount; }
    };

    clearViewerWatchdogs();
    viewerRetryCount = 0;

    // ------------------------------------------
    // 1. SYSTEM PREPARATION & DISPLAY SETTINGS
    // ------------------------------------------
    
    // Keep device screen active during movie playback (non-blocking so UI controls bind synchronously)
    requestWakeLock();
    
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
    // 2. QUALITY TOGGLE & ADAPTIVE FALLBACK UI
    // ------------------------------------------
    const qualityBtn = document.getElementById('qualityBtn');
    const qualityStatus = document.getElementById('qualityStatus');

    const setViewerQualityMode = (highQuality, emitToServer = true) => {
        isHighQuality = Boolean(highQuality);
        if (qualityBtn) {
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
        }
        if (emitToServer) {
            const mode = isHighQuality ? 'high' : 'low';
            console.log(`[Quality] Requesting bitrate mode: ${mode}`);
            socket.emit("bitrate_request", roomId, mode);
        }
    };

    if (qualityBtn) {
        qualityBtn.onclick = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            const nextHigh = !isHighQuality;
            setViewerQualityMode(nextHigh, true);
            displayNotification(
                nextHigh
                    ? "📶 Quality set to HD (High Definition)."
                    : "📶 Quality set to SD (Data Saver / Smooth Playout).",
                "info"
            );
        };
    }

    // ------------------------------------------
    // 3. NIGHT MODE / COZY DIALOGUE COMPRESSOR
    // ------------------------------------------
    let nightModeActive = Boolean(window.nightModeActive);

    const nightBtn = document.getElementById('nightBtn');
    const nightStatus = document.getElementById('nightStatus') || (nightBtn ? nightBtn.querySelector('span') : null);

    const updateNightModeButtonUI = (active) => {
        if (!nightBtn) return;
        if (active) {
            nightBtn.classList.remove('text-indigo-300/80', 'text-indigo-400', 'border-transparent');
            nightBtn.classList.add('text-white', 'bg-indigo-600/50', 'border-indigo-400/40', 'animate-pulse');
            if (nightStatus) nightStatus.innerText = 'Cozy: ON';
        } else {
            nightBtn.classList.remove('text-white', 'bg-indigo-600/50', 'border-indigo-400/40', 'animate-pulse');
            nightBtn.classList.add('text-indigo-300/80', 'border-transparent');
            if (nightStatus) nightStatus.innerText = 'Cozy';
        }
    };

    const syncNightModeAudio = () => {
        if (!nightModeActive) {
            if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
                dialogueCompressorHandle.destroy();
                dialogueCompressorHandle = null;
            }
            return false;
        }
        const hasAudioTrack = Boolean(
            videoElement && videoElement.srcObject &&
            typeof videoElement.srcObject.getAudioTracks === 'function' &&
            videoElement.srcObject.getAudioTracks().length > 0
        );
        if (!hasAudioTrack) {
            return false;
        }
        if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
            dialogueCompressorHandle.destroy();
            dialogueCompressorHandle = null;
        }
        const handle = setupDialogueCompressor(videoElement);
        if (handle) {
            dialogueCompressorHandle = handle;
            return true;
        }
        return false;
    };

    const disableNightModeUI = () => {
        nightModeActive = false;
        window.nightModeActive = false;
        updateNightModeButtonUI(false);
        if (dialogueCompressorHandle && typeof dialogueCompressorHandle.destroy === 'function') {
            dialogueCompressorHandle.destroy();
            dialogueCompressorHandle = null;
        }
    };

    // Sync initial Cozy state if user toggled Cozy before clicking Join Movie
    updateNightModeButtonUI(nightModeActive);
    if (nightModeActive) {
        syncNightModeAudio();
    }

    if (nightBtn) {
        nightBtn.onclick = (e) => {
            if (e) {
                e.preventDefault();
                e.stopPropagation();
            }
            if (!nightModeActive) {
                nightModeActive = true;
                window.nightModeActive = true;
                updateNightModeButtonUI(true);
                const boundNow = syncNightModeAudio();
                displayNotification(
                    boundNow
                        ? "🌙 Cozy Mode ON: Boosting quiet dialogue & softening loud scenes."
                        : "🌙 Cozy Mode ON: Armed — dialogue boost will apply automatically when movie audio plays.",
                    "info"
                );
            } else {
                disableNightModeUI();
                displayNotification("🌙 Cozy Mode OFF: Standard cinema dynamic range restored.", "info");
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

    const safePlayViewerVideo = () => {
        if (!videoElement) return;
        const playPromise = videoElement.play();
        if (playPromise !== undefined && typeof playPromise.catch === 'function') {
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
    };

    const flushPendingCandidatesForHost = async (targetPc, targetHostId, currentGen) => {
        const now = Date.now();
        const matching = pendingCandidates.filter(item => item.id === targetHostId && (!item.ts || (now - item.ts) < 8000));
        pendingCandidates = pendingCandidates.filter(item => item.id !== targetHostId && (!item.ts || (now - item.ts) < 8000));
        for (const item of matching) {
            if (peerConnection === targetPc && offerGeneration === currentGen && item.candidate && item.candidate.candidate) {
                await targetPc.addIceCandidate(new RTCIceCandidate(item.candidate)).catch(e => console.warn("[ICE] Queued candidate error:", e));
            }
        }
    };

    const startViewerHealthMonitor = (activePc) => {
        if (viewerHealthInterval) clearInterval(viewerHealthInterval);
        let prevPacketsReceived = 0;
        let prevPacketsLost = 0;
        let prevFramesDecoded = 0;
        let lastCurrentTime = videoElement ? videoElement.currentTime : 0;
        let stallCount = 0;
        let blackScreenCount = 0;

        viewerHealthInterval = setInterval(async () => {
            if (peerConnection !== activePc) {
                clearInterval(viewerHealthInterval);
                viewerHealthInterval = null;
                return;
            }
            const iceState = activePc.iceConnectionState;
            if (iceState !== 'connected' && iceState !== 'completed') return;

            let lossRatio = 0;
            let packetsReceived = 0;
            let framesDecoded = 0;
            let framesDelta = 0;
            if (typeof activePc.getStats === 'function') {
                try {
                    const stats = await activePc.getStats();
                    if (peerConnection !== activePc) return;
                    let packetsLost = 0;
                    stats.forEach(report => {
                        if (report.type === 'inbound-rtp' && report.kind === 'video') {
                            packetsReceived = report.packetsReceived || 0;
                            packetsLost = report.packetsLost || 0;
                            framesDecoded = report.framesDecoded || 0;
                        }
                    });
                    if (packetsReceived > prevPacketsReceived) {
                        const recvDelta = packetsReceived - prevPacketsReceived;
                        const lostDelta = Math.max(0, packetsLost - prevPacketsLost);
                        if (recvDelta + lostDelta > 10) {
                            lossRatio = lostDelta / (recvDelta + lostDelta);
                        }
                    }
                    framesDelta = Math.max(0, framesDecoded - prevFramesDecoded);
                    prevPacketsReceived = packetsReceived;
                    prevPacketsLost = packetsLost;
                    prevFramesDecoded = framesDecoded;
                } catch (e) {}
            }

            const hasVideoTrack = Boolean(
                videoElement && videoElement.srcObject &&
                typeof videoElement.srcObject.getVideoTracks === 'function' &&
                videoElement.srcObject.getVideoTracks().length > 0
            );
            const videoWidth = videoElement ? (videoElement.videoWidth || 0) : 0;
            const videoHeight = videoElement ? (videoElement.videoHeight || 0) : 0;

            // Detect Black Screen / Decoder Stall even when programme audio advances currentTime & readyState
            const isVideoBlackOrStalled = hasVideoTrack && (
                videoWidth === 0 ||
                videoHeight === 0 ||
                (packetsReceived > 15 && framesDecoded === 0) ||
                (packetsReceived > 30 && framesDelta === 0 && videoElement.paused)
            );

            if (isVideoBlackOrStalled) {
                blackScreenCount++;
                console.warn(`[Recovery] Black screen or decoder stall check #${blackScreenCount} (videoWidth=${videoWidth}, framesDecoded=${framesDecoded}, packets=${packetsReceived})`);
                if (blackScreenCount === 1) {
                    // Stage 1: Re-bind MediaStream surface on <video>, ensure playout, and request SD profile
                    if (window.movieStream && videoElement) {
                        const refreshedStream = new MediaStream(window.movieStream.getTracks());
                        window.movieStream = refreshedStream;
                        videoElement.srcObject = refreshedStream;
                        if (nightModeActive) {
                            syncNightModeAudio();
                        }
                        safePlayViewerVideo();
                    }
                    if (isHighQuality) {
                        setViewerQualityMode(false, true);
                    } else {
                        socket.emit("bitrate_request", roomId, 'low');
                    }
                } else if (blackScreenCount >= 2 && blackScreenRecoveryCount < 3) {
                    // Stage 2: Hardware decoder incompatible with current codec/profile or lost initial IDR keyframe.
                    // Rotate codec preference (VP8 <-> Constrained Baseline H264) and request fresh Offer + IDR keyframe.
                    blackScreenCount = 0;
                    blackScreenRecoveryCount++;
                    forceFreshPeerConnection = true;
                    console.warn(`[Recovery] Triggering codec & keyframe renegotiation (recovery step ${blackScreenRecoveryCount})...`);
                    setViewerQualityMode(false, true);
                    if (socket.connected) {
                        socket.emit("watcher", username);
                    }
                }
            } else if (videoWidth > 0 && videoHeight > 0) {
                blackScreenCount = 0;
                blackScreenRecoveryCount = 0;
            }

            if (videoElement && videoElement.srcObject && !videoElement.paused) {
                const curTime = videoElement.currentTime;
                if (curTime === lastCurrentTime && videoElement.readyState < 3) {
                    stallCount++;
                } else {
                    stallCount = 0;
                }
                lastCurrentTime = curTime;
            }

            if (isHighQuality && (lossRatio > 0.08 || stallCount >= 2)) {
                console.warn(`[Quality] High inbound loss (${(lossRatio * 100).toFixed(1)}%) or playback stall detected; auto-switching to SD fallback.`);
                setViewerQualityMode(false, true);
                stallCount = 0;
            }
        }, 2400);
    };

    const scheduleViewerHandshakeWatchdog = () => {
        if (viewerHandshakeTimer) clearTimeout(viewerHandshakeTimer);
        viewerHandshakeTimer = setTimeout(() => {
            viewerHandshakeTimer = null;
            const iceState = peerConnection ? peerConnection.iceConnectionState : 'none';
            const isConnected = iceState === 'connected' || iceState === 'completed';
            const hasDecodedVideo = Boolean(
                videoElement && videoElement.srcObject &&
                typeof videoElement.srcObject.getVideoTracks === 'function' &&
                videoElement.srcObject.getVideoTracks().length > 0 &&
                videoElement.readyState >= 2 &&
                videoElement.videoWidth > 0
            );
            if (!isConnected && !hasDecodedVideo && viewerRetryCount < 3) {
                viewerRetryCount++;
                forceFreshPeerConnection = true;
                blackScreenRecoveryCount = Math.max(blackScreenRecoveryCount, 1);
                console.warn(`[WebRTC] Viewer handshake watchdog fired (state: ${iceState}, attempt: ${viewerRetryCount}). Requesting fallback stream...`);
                setViewerQualityMode(false, true);
                if (socket.connected) {
                    socket.emit("watcher", username);
                }
                scheduleViewerHandshakeWatchdog();
            }
        }, 6000);
    };
    
    // Handle WebRTC Offer from Broadcaster
    socket.off("offer");
    socket.on("offer", async (id, description) => {
        if (!description || typeof description.sdp !== 'string') return;
        const currentGen = ++offerGeneration;
        isApplyingOffer = true;
        console.log(`[WebRTC] Received Offer from Host: ${id} (gen ${currentGen})`);

        if (hostDisconnectTimer) {
            clearTimeout(hostDisconnectTimer);
            hostDisconnectTimer = null;
        }
        if (viewerRecoveryTimer) {
            clearTimeout(viewerRecoveryTimer);
            viewerRecoveryTimer = null;
        }
        scheduleViewerHandshakeWatchdog();

        // Fast-path: In-place ICE Restart on existing stable connection with same Host
        // Only used when the existing PC already established media and is not forcing a clean decoder reset
        const existingIce = peerConnection ? peerConnection.iceConnectionState : 'closed';
        const canRestartInPlace = Boolean(
            !forceFreshPeerConnection &&
            peerConnection &&
            hostId === id &&
            peerConnection.signalingState === 'stable' &&
            (existingIce === 'connected' || existingIce === 'completed' || existingIce === 'disconnected') &&
            videoElement && videoElement.srcObject && videoElement.readyState >= 2
        );

        if (canRestartInPlace) {
            const existingPc = peerConnection;
            try {
                console.log("[WebRTC] Performing seamless in-place ICE restart with Host...");
                await existingPc.setRemoteDescription(description);
                if (peerConnection !== existingPc || offerGeneration !== currentGen) return;

                const restartAnswer = await existingPc.createAnswer();
                if (peerConnection !== existingPc || offerGeneration !== currentGen) return;

                await existingPc.setLocalDescription(restartAnswer);
                if (peerConnection !== existingPc || offerGeneration !== currentGen) return;

                await waitForInitialCandidates(existingPc, 80);
                if (peerConnection !== existingPc || offerGeneration !== currentGen) return;

                isApplyingOffer = false;
                socket.emit("answer", id, existingPc.localDescription);
                await flushPendingCandidatesForHost(existingPc, id, currentGen);
                safePlayViewerVideo();
                return;
            } catch (inPlaceErr) {
                console.warn("[WebRTC] In-place ICE restart failed; falling back to fresh RTCPeerConnection:", inPlaceErr);
                if (peerConnection !== existingPc || offerGeneration !== currentGen) return;
            }
        }
        forceFreshPeerConnection = false;

        if (hostId && hostId !== id) {
            const prevVoiceEl = document.getElementById(`hostVoice_${hostId}`);
            if (prevVoiceEl && prevVoiceEl.parentNode) prevVoiceEl.parentNode.removeChild(prevVoiceEl);
        }
        hostId = id;
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
            try {
                peerConnection.oniceconnectionstatechange = null;
                peerConnection.onicecandidate = null;
                peerConnection.ontrack = null;
                peerConnection.close();
            } catch (e) {}
            window.movieStream = null;
            intercomTransceiverRef = null;
        }
        
        const activePc = new RTCPeerConnection(rtcConfiguration);
        peerConnection = activePc;

        // Identify the Intercom media section from the Offer SDP before setRemoteDescription:
        // Programme Audio is offered as 'sendonly'; Voice Intercom is offered as 'sendrecv' (screen mode) or 'recvonly' (camera mode).
        const { mediaSections } = parseSDPSections(description.sdp);
        const intercomSection = mediaSections.find(
            s => s.mediaType === 'audio' && (s.direction === 'sendrecv' || s.direction === 'recvonly')
        );
        const intercomMid = intercomSection ? intercomSection.mid : null;
        const intercomSectionIdx = intercomSection ? mediaSections.indexOf(intercomSection) : -1;

        // Discrete Incoming Stream Routing
        activePc.ontrack = event => {
            if (peerConnection !== activePc) return;
            console.log("[WebRTC] Track received:", event.track.kind);
            const transceiver = event.transceiver;
            const currentTransceivers = activePc.getTransceivers();
            const isIntercomTrack = event.track.kind === 'audio' && Boolean(
                (intercomMid && transceiver && transceiver.mid === intercomMid) ||
                (!intercomMid && intercomSectionIdx >= 0 && currentTransceivers.indexOf(transceiver) === intercomSectionIdx)
            );
            
            // Movie Component (Video or Programme Audio)
            if (event.track.kind === 'video' || !isIntercomTrack) {
                if (!window.movieStream) {
                    window.movieStream = new MediaStream();
                }
                const existingTracks = window.movieStream.getTracks().filter(t => t.kind === event.track.kind && t.id !== event.track.id);
                existingTracks.forEach(t => window.movieStream.removeTrack(t));
                if (!window.movieStream.getTracks().some(t => t.id === event.track.id)) {
                    window.movieStream.addTrack(event.track);
                }
                // Attach MediaStream to <video> after track is added so mobile WebMediaPlayerMS registers both audio and video sinks
                if (videoElement.srcObject !== window.movieStream) {
                    videoElement.srcObject = window.movieStream;
                }

                // When remote video track unmutes (first RTP keyframe arrives over UDP), ensure surface binding & playback on Android/Pixel
                if (event.track.kind === 'video') {
                    event.track.addEventListener('unmute', () => {
                        if (peerConnection !== activePc || !window.movieStream) return;
                        if (videoElement.srcObject !== window.movieStream) {
                            videoElement.srcObject = window.movieStream;
                        }
                        safePlayViewerVideo();
                        setTimeout(() => {
                            if (peerConnection === activePc && window.movieStream && videoElement && videoElement.videoWidth === 0) {
                                console.warn("[Player] Video unmuted but videoWidth is 0; refreshing MediaStream surface binding...");
                                const refreshed = new MediaStream(window.movieStream.getTracks());
                                window.movieStream = refreshed;
                                videoElement.srcObject = refreshed;
                                if (nightModeActive) {
                                    syncNightModeAudio();
                                }
                                safePlayViewerVideo();
                            }
                        }, 1200);
                    });
                }

                // Re-bind Night Mode / Dialogue Compressor if active when audio track arrives
                if (event.track.kind === 'audio' && nightModeActive) {
                    syncNightModeAudio();
                }
                
                safePlayViewerVideo();
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
        activePc.onicecandidate = event => {
            if (peerConnection !== activePc) return;
            if (event.candidate) {
                socket.emit("candidate", id, event.candidate);
            }
        };
        
        // Monitor Direct Connection Health with Self-Healing Fallback
        activePc.oniceconnectionstatechange = () => {
            if (peerConnection !== activePc) return;
            const state = activePc.iceConnectionState;
            console.log(`[ICE] Direct Connection State: ${state}`);
            if (state === 'connected' || state === 'completed') {
                console.log("[ICE] Direct P2P connection established successfully.");
                if (viewerHandshakeTimer) {
                    clearTimeout(viewerHandshakeTimer);
                    viewerHandshakeTimer = null;
                }
                if (viewerRecoveryTimer) {
                    clearTimeout(viewerRecoveryTimer);
                    viewerRecoveryTimer = null;
                }
                viewerRetryCount = 0;
                if (!isHighQuality) {
                    socket.emit("bitrate_request", roomId, 'low');
                }
                safePlayViewerVideo();
                startViewerHealthMonitor(activePc);
            } else if (state === 'disconnected') {
                console.warn("[ICE] Stream connection temporarily interrupted; stepping down to SD fallback.");
                if (isHighQuality) {
                    setViewerQualityMode(false, true);
                }
                if (viewerRecoveryTimer) clearTimeout(viewerRecoveryTimer);
                viewerRecoveryTimer = setTimeout(() => {
                    viewerRecoveryTimer = null;
                    if (peerConnection !== activePc) return;
                    if (activePc.iceConnectionState === 'disconnected' && viewerRetryCount < 3) {
                        viewerRetryCount++;
                        console.warn("[ICE] Connection still disconnected after grace window; requesting stream recovery...");
                        socket.emit("bitrate_request", roomId, 'low');
                        socket.emit("watcher", username);
                    }
                }, 4200);
            } else if (state === 'failed') {
                if (viewerRetryCount < 2) {
                    viewerRetryCount++;
                    forceFreshPeerConnection = true;
                    console.warn(`[ICE] Direct connection failed (attempt ${viewerRetryCount}); attempting fallback recovery...`);
                    setViewerQualityMode(false, true);
                    socket.emit("watcher", username);
                    scheduleViewerHandshakeWatchdog();
                    return;
                }
                const diagMsg = getDirectConnectionDiagnostics('failed');
                console.error("[ICE] Direct P2P connection failed:", diagMsg);
                displayNotification(diagMsg, "error");
            } else if (state === 'closed') {
                console.log("[ICE] Peer connection closed.");
            }
        };

        // Process Offer, Configure Video Codec & Intercom Transceiver Direction, & Emit Answer
        try {
            await activePc.setRemoteDescription(description);
            if (peerConnection !== activePc || offerGeneration !== currentGen) return;

            const transceivers = activePc.getTransceivers();

            // Prefer universal VP8 / Constrained Baseline H264 on mobile (Google Pixel / Android / iOS) or during recovery
            const videoTransceiver = transceivers.find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
            if (videoTransceiver) {
                const preferUniversal = isMobileOrTouchViewer() || !isHighQuality || viewerRetryCount > 0 || blackScreenRecoveryCount > 0;
                configureViewerVideoCodecs(videoTransceiver, preferUniversal, blackScreenRecoveryCount);
            }

            // Configure the Intercom transceiver to allow sending Viewer mic audio back to Host
            intercomTransceiverRef = (intercomMid && transceivers.find(t => t.mid === intercomMid)) ||
                (intercomSectionIdx >= 0 && transceivers[intercomSectionIdx]) ||
                null;

            if (intercomTransceiverRef) {
                // If Host offered 'recvonly' (Camera mode), Viewer answers 'sendonly'; if 'sendrecv' (Screen mode), Viewer answers 'sendrecv'
                intercomTransceiverRef.direction = (intercomSection && intercomSection.direction === 'recvonly') ? 'sendonly' : 'sendrecv';
                if (!isMuted && localAudioStream && localAudioStream.getAudioTracks()[0] && intercomTransceiverRef.sender) {
                    await intercomTransceiverRef.sender.replaceTrack(localAudioStream.getAudioTracks()[0]);
                    if (peerConnection !== activePc || offerGeneration !== currentGen) return;
                }
            }

            const answer = await activePc.createAnswer();
            if (peerConnection !== activePc || offerGeneration !== currentGen) return;

            await activePc.setLocalDescription(answer);
            if (peerConnection !== activePc || offerGeneration !== currentGen) return;

            // Wait briefly (up to 100ms) so Viewer's LAN Wi-Fi (host) & STUN (srflx) candidates are embedded in the Answer SDP
            await waitForInitialCandidates(activePc, 100);
            if (peerConnection !== activePc || offerGeneration !== currentGen) return;
            
            isApplyingOffer = false;
            console.log("[WebRTC] Sending Answer to Host...");
            socket.emit("answer", id, activePc.localDescription);

            // Flush any ICE candidates that arrived before setRemoteDescription/setLocalDescription completed
            await flushPendingCandidatesForHost(activePc, id, currentGen);
        } catch (err) {
            isApplyingOffer = false;
            console.error("[WebRTC] Handshake Error:", err);
        }
    });

    // Handle ICE Candidates from Host (Buffer while an Offer/Answer is being applied or if not yet stable)
    socket.off("candidate");
    socket.on("candidate", (id, candidate) => {
        if (!candidate) return;
        if (typeof candidate.candidate === 'string' && candidate.candidate.trim() === '') return;
        if (!isApplyingOffer && peerConnection && hostId === id && peerConnection.remoteDescription && peerConnection.remoteDescription.type && peerConnection.localDescription && peerConnection.signalingState === 'stable') {
            peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => console.warn("[ICE] Error adding candidate:", e));
        } else {
            pendingCandidates.push({ id, candidate, ts: Date.now() });
        }
    });

    // Host Present / Joined Signal: Record active Host ID and cancel disconnect grace timer when Host joins/rejoins
    socket.off("host-present");
    socket.on("host-present", (currentHostId) => {
        if (currentHostId) {
            hostId = currentHostId;
        }
    });

    socket.off("host-joined");
    socket.on("host-joined", (newHostId) => {
        console.log("[Signal] Host joined/rejoined the room:", newHostId);
        hostId = newHostId;
        viewerRetryCount = 0;
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
        viewerRetryCount = 0;
        forceFreshPeerConnection = true;
        socket.emit("watcher", username);
        scheduleViewerHandshakeWatchdog();
    });

    // Actively request stream on viewer initialization and on socket reconnects
    // Coalesce reconnect signal so it does not collide with room.html's join-room watcher emission
    socket.off("connect", window._viewerReconnectHandler);
    window._viewerReconnectHandler = () => {
        if (viewerReconnectTimer) clearTimeout(viewerReconnectTimer);
        const genAtConnect = offerGeneration;
        viewerReconnectTimer = setTimeout(() => {
            viewerReconnectTimer = null;
            if (offerGeneration === genAtConnect && socket.connected) {
                socket.emit("watcher", username);
                scheduleViewerHandshakeWatchdog();
            }
        }, 350);
    };
    socket.on("connect", window._viewerReconnectHandler);
    if (socket.connected) {
        socket.emit("watcher", username);
        scheduleViewerHandshakeWatchdog();
    }

    // Broadcaster Signal: Host paused/stopped screen share while staying in room
    socket.off("broadcast-stopped");
    socket.on("broadcast-stopped", () => {
        console.log("[Signal] Host stopped active media broadcast.");
        clearViewerWatchdogs();
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

    const handleHostDisconnected = (disconnectedHostId) => {
        if (hostDisconnectTimer) return; // Grace timer already running
        console.log("[Signal] Host socket disconnected. Starting 15s reconnection grace window...");
        clearViewerWatchdogs();
        if (duckingController) {
            duckingController.unregisterVoiceTrack('host');
        }
        const targetVoiceId = disconnectedHostId || hostId;
        const hostVoiceEl = targetVoiceId ? document.getElementById(`hostVoice_${targetVoiceId}`) : null;
        if (hostVoiceEl && hostVoiceEl.parentNode) hostVoiceEl.parentNode.removeChild(hostVoiceEl);
        displayNotification("Host connection interrupted. Waiting up to 15s for Host to reconnect...", "warning");
        hostDisconnectTimer = setTimeout(() => {
            hostDisconnectTimer = null;
            cleanupViewerResources();
            displayNotification("The Host has ended the stream.", "info");
            setTimeout(() => {
                if (socket && socket.connected) {
                    socket.emit("leave-room", roomId);
                    socket.disconnect();
                }
                window.location.href = "/";
            }, 1000);
        }, 15000);
    };
    
    // Host Disconnection Guard (Aligns with server's 15-second reconnection grace period)
    socket.off("host-left");
    socket.on("host-left", (leftHostId) => {
        if (!hostId || leftHostId === hostId) {
            handleHostDisconnected(leftHostId);
        }
    });

    socket.off("disconnectPeer");
    socket.on("disconnectPeer", (disconnectedId) => {
        if (disconnectedId === hostId) {
            handleHostDisconnected(disconnectedId);
        } else {
            console.log(`[Signal] Viewer ${disconnectedId} left the room.`);
        }
    });
    
    // Clean Viewer Session Teardown
    const cleanupViewerResources = () => {
        clearViewerWatchdogs();
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
        if (window._viewerMicCtrl) {
            window._viewerMicCtrl.destroy();
            window._viewerMicCtrl = null;
        }
        if (localAudioStream) {
            localAudioStream.getTracks().forEach(t => t.stop());
            localAudioStream = null;
        }
        if (peerConnection) {
            try { peerConnection.close(); } catch (e) {}
            peerConnection = null;
        }
        if (wakeLock) {
            try { wakeLock.release(); } catch (e) {}
            wakeLock = null;
        }
    };
    window.cleanupViewerSession = cleanupViewerResources;
    window.addEventListener('pagehide', cleanupViewerResources, { once: true });
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
