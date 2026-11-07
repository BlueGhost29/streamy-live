// src/public/js/modules/media/capture.js

/**
 * Screen & Camera Capture Engine
 * 
 * Implements:
 * 1. Dedicated, explicit Screen Capture waterfall with user cancellation protection.
 * 2. Dedicated, explicit Camera Broadcasting pipeline with AEC-enabled speech audio.
 * 3. Accurate error classification (cancelled vs unsupported vs permission denied vs insecure context).
 * 4. Zero silent camera fallbacks: camera broadcasting must be an intentional host choice.
 */

export class CaptureError extends Error {
    /**
     * @param {string} message - Human-readable error description.
     * @param {'cancelled'|'unsupported'|'permission_denied'|'insecure_context'|'failed'|'no_devices'} reason
     * @param {Error|null} [originalError]
     */
    constructor(message, reason, originalError = null) {
        super(message);
        this.name = 'CaptureError';
        this.reason = reason;
        this.originalError = originalError;
    }
}

/**
 * Safely stops and releases all tracks in a MediaStream.
 * 
 * @param {MediaStream|null} stream 
 */
export function stopStreamTracks(stream) {
    if (!stream) return;
    if (typeof stream._fileCleanup === 'function') {
        try {
            stream._fileCleanup();
        } catch (e) {
            console.warn("[Capture] Error cleaning up file stream:", e);
        }
    }
    if (typeof stream.getTracks !== 'function') return;
    stream.getTracks().forEach(track => {
        try {
            track.stop();
        } catch (e) {
            console.warn("[Capture] Error stopping track:", e);
        }
    });
}

/**
 * Executes the progressive screen capture waterfall with cancellation protection.
 * 
 * Attempts:
 * 1. Strict 1080p60 & raw system audio (AGC: false, AEC: false, NS: false).
 * 2. Generic display media (video + audio).
 * 3. Video-only display media (when OS/browser restricts display audio).
 * 
 * @returns {Promise<MediaStream>} The acquired desktop screen stream.
 * @throws {CaptureError} On user cancellation, unsupported platform, or permission failure.
 */
export async function captureScreenWithFallback() {
    console.log("[Capture] Requesting Screen Capture Media...");

    // Check secure context
    if (typeof window !== 'undefined' && !window.isSecureContext) {
        throw new CaptureError(
            "Screen capture requires a Secure Context (HTTPS or localhost). Over local Wi-Fi, configure local HTTPS.",
            "insecure_context"
        );
    }

    // Check API support
    const hasDisplayMedia = Boolean(
        typeof navigator !== 'undefined' &&
        navigator.mediaDevices &&
        typeof navigator.mediaDevices.getDisplayMedia === 'function'
    );

    if (!hasDisplayMedia) {
        console.warn("[Capture] navigator.mediaDevices.getDisplayMedia is unsupported on this browser/platform.");
        throw new CaptureError(
            "Screen sharing is not supported by this browser. To share a movie, please host from a desktop browser, or choose Live Camera mode.",
            "unsupported"
        );
    }

    const isUserCancellation = (err) => {
        if (!err) return false;
        // Standard user dismissals / cancel button
        return err.name === 'NotAllowedError' || err.name === 'AbortError';
    };

    const isUnsupportedError = (err) => {
        if (!err) return false;
        return err.name === 'NotSupportedError' || err.name === 'InvalidAccessError';
    };

    try {
        // Attempt 1: Strict High Quality desktop capture (1080p60, raw movie audio)
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                height: { ideal: 1080 },
                frameRate: { ideal: 60 }
            },
            audio: {
                autoGainControl: false,
                echoCancellation: false,
                noiseSuppression: false
            }
        });
        return stream;
    } catch (err) {
        if (isUserCancellation(err)) {
            console.warn("[Capture] User cancelled screen sharing at strict tier.");
            throw new CaptureError("Screen sharing was cancelled by the user.", "cancelled", err);
        }
        if (isUnsupportedError(err)) {
            console.warn("[Capture] Display media unsupported at runtime on this device:", err);
            throw new CaptureError(
                "Screen sharing is not supported by this browser. To share a movie, please host from a desktop browser, or choose Live Camera mode.",
                "unsupported",
                err
            );
        }
        console.log("[Capture] Strict 1080p60/raw audio failed, falling back to generic capture...", err);

        try {
            // Attempt 2: Generic capture (MacOS / Android / Safari with basic constraints)
            const stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: true
            });
            return stream;
        } catch (err2) {
            if (isUserCancellation(err2)) {
                console.warn("[Capture] User cancelled screen sharing at generic tier.");
                throw new CaptureError("Screen sharing was cancelled by the user.", "cancelled", err2);
            }
            if (isUnsupportedError(err2)) {
                throw new CaptureError(
                    "Screen sharing is not supported by this browser. To share a movie, please host from a desktop browser, or choose Live Camera mode.",
                    "unsupported",
                    err2
                );
            }
            console.log("[Capture] Generic audio blocked, falling back to video-only capture...", err2);

            try {
                // Attempt 3: Pure video fallback (iOS / Safari / platforms restricting display audio)
                const stream = await navigator.mediaDevices.getDisplayMedia({
                    video: true
                });
                return stream;
            } catch (fallbackErr) {
                if (isUserCancellation(fallbackErr)) {
                    console.warn("[Capture] User cancelled screen sharing at video-only tier.");
                    throw new CaptureError("Screen sharing was cancelled by the user.", "cancelled", fallbackErr);
                }
                if (isUnsupportedError(fallbackErr)) {
                    throw new CaptureError(
                        "Screen sharing is not supported by this browser. To share a movie, please host from a desktop browser, or choose Live Camera mode.",
                        "unsupported",
                        fallbackErr
                    );
                }
                console.error("[Capture] Screen capture completely failed:", fallbackErr);
                throw new CaptureError(
                    "Unable to acquire screen capture. Please verify browser permissions and display support.",
                    "failed",
                    fallbackErr
                );
            }
        }
    }
}

/**
 * Dedicated Camera & Microphone Capture Pipeline for deliberate Camera Broadcasting.
 * 
 * Captures camera video and microphone audio configured with platform AEC, AGC, and Noise Suppression
 * suitable for live speech broadcasting.
 * 
 * @param {object} [options]
 * @param {'user'|'environment'} [options.facingMode='user'] - Front or rear camera.
 * @param {boolean} [options.audio=true] - Whether to capture host microphone.
 * @param {number} [options.height=1080] - Ideal video height.
 * @returns {Promise<MediaStream>} The acquired camera and mic stream.
 * @throws {CaptureError}
 */
export async function captureCameraStream({ facingMode = 'user', audio = true, height = 1080 } = {}) {
    console.log(`[Capture] Requesting Live Camera Media (facingMode: ${facingMode}, audio: ${audio})...`);

    // Check secure context
    if (typeof window !== 'undefined' && !window.isSecureContext) {
        throw new CaptureError(
            "Camera broadcasting requires a Secure Context (HTTPS or localhost). Over local Wi-Fi, configure local HTTPS.",
            "insecure_context"
        );
    }

    // Check API support
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new CaptureError(
            "Camera and microphone capture are unsupported on this platform.",
            "unsupported"
        );
    }

    const constraints = {
        video: {
            facingMode: facingMode ? { ideal: facingMode } : undefined,
            height: { ideal: height }
        },
        audio: audio ? {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1
        } : false
    };

    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log(`[Capture] Camera stream acquired. Video tracks: ${stream.getVideoTracks().length}, Audio tracks: ${stream.getAudioTracks().length}`);
        return stream;
    } catch (err) {
        if (err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
            throw new CaptureError(
                "Camera or microphone permission was denied. Please allow camera and microphone access in browser settings.",
                "permission_denied",
                err
            );
        }
        console.warn("[Capture] Initial camera constraints failed, attempting 720p30 mobile fallback...", err);

        // Fallback 1: 720p30 camera with basic echoCancellation (ideal for mobile cameras)
        try {
            const mobileStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: facingMode ? { ideal: facingMode } : undefined,
                    height: { ideal: 720 },
                    frameRate: { ideal: 30 }
                },
                audio: audio ? { echoCancellation: true } : false
            });
            return mobileStream;
        } catch (err720) {
            console.warn("[Capture] 720p30 camera fallback failed, attempting generic camera capture...", err720);

            // Fallback 2: Generic video/audio without ideal resolution constraints
            try {
                const fallbackStream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: audio ? { echoCancellation: true } : false
                });
                return fallbackStream;
            } catch (errGeneric) {
                // Fallback 3: If audio was requested and caused a hardware/busy conflict, attempt video-only camera capture
                if (audio && errGeneric && errGeneric.name !== 'NotAllowedError' && errGeneric.name !== 'PermissionDeniedError') {
                    try {
                        console.warn("[Capture] Audio-coupled camera capture failed; attempting video-only camera fallback...", errGeneric);
                        const videoOnlyStream = await navigator.mediaDevices.getUserMedia({
                            video: facingMode ? { facingMode: { ideal: facingMode } } : true,
                            audio: false
                        });
                        return videoOnlyStream;
                    } catch (videoOnlyErr) {
                        // Fall through to unified error handler below
                    }
                }

                console.error("[Capture] Camera capture failed:", errGeneric);
                if (errGeneric.name === 'NotAllowedError' || errGeneric.name === 'PermissionDeniedError') {
                    throw new CaptureError(
                        "Camera or microphone permission was denied. Please allow camera and microphone access in browser settings.",
                        "permission_denied",
                        errGeneric
                    );
                } else if (errGeneric.name === 'NotFoundError' || errGeneric.name === 'DevicesNotFoundError') {
                    throw new CaptureError(
                        "No camera or microphone device was found on this system.",
                        "no_devices",
                        errGeneric
                    );
                }
                throw new CaptureError(
                    "Unable to access camera or microphone. Please check device permissions.",
                    "failed",
                    errGeneric
                );
            }
        }
    }
}

/**
 * Converts SubRip (.srt) or WebVTT (.vtt) text into a valid WebVTT string
 * for native <track kind="subtitles"> playback during Anime & Movie streaming.
 * 
 * @param {string} rawText - Raw .srt or .vtt file content.
 * @returns {string} Valid WebVTT content string.
 */
export function convertSrtToVtt(rawText) {
    if (typeof rawText !== 'string') return 'WEBVTT\n\n';
    const trimmed = rawText.replace(/^\uFEFF/, '').trim();
    if (trimmed.startsWith('WEBVTT')) {
        return trimmed + '\n';
    }
    const vttBody = trimmed
        .replace(/\r\n/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
    return `WEBVTT\n\n${vttBody}\n`;
}

/**
 * Cross-Platform Local Video File Stream Capture Engine (Windows, iPadOS/iOS, Android).
 * 
 * Allows a Host on any platform (including iPad and Android where getDisplayMedia is restricted)
 * to stream a local movie or anime video file (.mp4, .webm, .mkv, .mov) in full HD with stereo audio.
 * 
 * Uses native HTMLMediaElement.captureStream() where available (Windows/Android Chromium & Firefox)
 * and automatically falls back to a 60fps Canvas + Web Audio MediaStreamDestination pipeline on WebKit/iPadOS.
 * 
 * @param {File|Blob} file - Selected video file.
 * @param {HTMLVideoElement} videoElement - The Host's #mainVideo element.
 * @returns {Promise<MediaStream>} A unified MediaStream containing the file's video and audio tracks.
 */
export async function captureVideoFileStream(file, videoElement) {
    if (!file || !videoElement) {
        throw new CaptureError("No video file selected.", "cancelled");
    }

    const fileUrl = URL.createObjectURL(file);
    videoElement.srcObject = null;
    videoElement.src = fileUrl;
    videoElement.muted = false;
    videoElement.loop = false;
    videoElement.playsInline = true;
    videoElement.controls = true;

    await new Promise((resolve, reject) => {
        const onLoaded = () => {
            cleanupListeners();
            resolve();
        };
        const onError = (err) => {
            cleanupListeners();
            URL.revokeObjectURL(fileUrl);
            reject(new CaptureError("Unsupported or corrupted video file format.", "failed", err));
        };
        const cleanupListeners = () => {
            videoElement.removeEventListener('loadedmetadata', onLoaded);
            videoElement.removeEventListener('error', onError);
        };
        videoElement.addEventListener('loadedmetadata', onLoaded, { once: true });
        videoElement.addEventListener('error', onError, { once: true });
    });

    try {
        await videoElement.play();
    } catch (playErr) {
        console.warn("[Capture] Unmuted file play deferred; starting playback...", playErr);
    }

    let capturedStream = null;
    let canvasAnimId = null;
    let fileAudioCtx = null;

    // Strategy 1: Native HTMLMediaElement.captureStream (Chromium / Firefox / Android)
    const captureFn = videoElement.captureStream || videoElement.mozCaptureStream;
    if (typeof captureFn === 'function') {
        try {
            const nativeStream = captureFn.call(videoElement);
            const vTracks = nativeStream ? nativeStream.getVideoTracks() : [];
            if (vTracks.length > 0 && vTracks[0].readyState !== 'ended') {
                capturedStream = nativeStream;
            }
        } catch (e) {
            console.warn("[Capture] Native video.captureStream failed; using WebKit canvas/audio bridge:", e);
        }
    }

    // Strategy 2: WebKit / iPadOS / iOS Canvas + Web Audio MediaStreamDestination Bridge
    if (!capturedStream || capturedStream.getVideoTracks().length === 0) {
        const canvas = document.createElement('canvas');
        const vw = videoElement.videoWidth || 1280;
        const vh = videoElement.videoHeight || 720;
        const scale = Math.min(1, 1920 / vw, 1080 / vh);
        canvas.width = Math.max(2, Math.round(vw * scale));
        canvas.height = Math.max(2, Math.round(vh * scale));
        const ctx = canvas.getContext('2d', { alpha: false });

        const drawLoop = () => {
            if (!videoElement.paused && !videoElement.ended && videoElement.readyState >= 2) {
                try {
                    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
                } catch (e) {}
            }
            canvasAnimId = requestAnimationFrame(drawLoop);
        };
        canvasAnimId = requestAnimationFrame(drawLoop);

        const canvasStream = typeof canvas.captureStream === 'function' ? canvas.captureStream(30) : new MediaStream();
        const combined = new MediaStream();
        canvasStream.getVideoTracks().forEach(t => combined.addTrack(t));

        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass) {
                fileAudioCtx = new AudioContextClass();
                if (fileAudioCtx.state === 'suspended') {
                    fileAudioCtx.resume().catch(() => {});
                }
                const sourceNode = fileAudioCtx.createMediaElementSource(videoElement);
                const streamDest = fileAudioCtx.createMediaStreamDestination();
                sourceNode.connect(fileAudioCtx.destination);
                sourceNode.connect(streamDest);
                streamDest.stream.getAudioTracks().forEach(t => combined.addTrack(t));
            }
        } catch (audioErr) {
            console.warn("[Capture] Web Audio file extraction fallback warning:", audioErr);
        }

        capturedStream = combined;
    }

    capturedStream._isFileStream = true;
    capturedStream._fileCleanup = () => {
        if (canvasAnimId) {
            cancelAnimationFrame(canvasAnimId);
            canvasAnimId = null;
        }
        if (fileAudioCtx) {
            fileAudioCtx.close().catch(() => {});
            fileAudioCtx = null;
        }
        try {
            videoElement.pause();
            videoElement.controls = false;
            videoElement.removeAttribute('src');
            videoElement.load();
        } catch (e) {}
        URL.revokeObjectURL(fileUrl);
    };

    return capturedStream;
}
