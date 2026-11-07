// src/public/js/modules/core/capabilities.js

/**
 * Device & Browser Capability Detection Engine
 * 
 * Provides safe, non-invasive runtime feature detection for WebRTC, media capture,
 * security contexts, and display/input capabilities across desktop and mobile browsers.
 * 
 * Rules:
 * 1. Prefer runtime feature detection over brittle User-Agent parsing.
 * 2. Never invoke getDisplayMedia() during detection (it triggers user permission prompts).
 * 3. Free of DOM side-effects; returns pure status objects and diagnostic messages.
 */

/**
 * Detects the runtime capabilities of the current browser and platform.
 * 
 * @param {object} [mockWindow] - Optional window object for deterministic unit testing.
 * @returns {object} Immutable capabilities snapshot with helper methods.
 */
export function getDeviceCapabilities(mockWindow = null) {
    const win = mockWindow || (typeof window !== 'undefined' ? window : null);
    const nav = win?.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    const doc = win?.document || (typeof document !== 'undefined' ? document : null);

    // 1. Security Context (Mandatory for getUserMedia and getDisplayMedia)
    const isSecureContext = Boolean(win && win.isSecureContext);

    // 2. Media Devices APIs
    const hasMediaDevices = Boolean(nav && nav.mediaDevices);
    const hasGetUserMedia = Boolean(hasMediaDevices && typeof nav.mediaDevices.getUserMedia === 'function');
    
    // Check getDisplayMedia existence (strictly non-invoking)
    const hasGetDisplayMedia = Boolean(hasMediaDevices && typeof nav.mediaDevices.getDisplayMedia === 'function');

    // 3. Screen Wake Lock API
    const hasWakeLock = Boolean(nav && 'wakeLock' in nav);

    // 4. Fullscreen Capabilities
    const hasStandardFullscreen = Boolean(
        doc && (doc.fullscreenEnabled || (doc.documentElement && typeof doc.documentElement.requestFullscreen === 'function'))
    );
    const hasWebkitFullscreen = Boolean(
        doc && (doc.webkitFullscreenEnabled || (doc.documentElement && typeof doc.documentElement.webkitRequestFullscreen === 'function'))
    );

    // 5. Input & Ergonomics (Touch & Screen heuristics, not brittle UA version parsing)
    const hasTouch = Boolean(
        win && ('ontouchstart' in win || (nav && nav.maxTouchPoints > 0))
    );
    const isCoarsePointer = Boolean(
        win && win.matchMedia && win.matchMedia('(pointer: coarse)').matches
    );
    const isLikelyMobile = Boolean(hasTouch && (isCoarsePointer || (win && win.innerWidth < 1024)));

    // 6. High-Level Role Availabilities
    const canScreenShare = Boolean(isSecureContext && hasGetDisplayMedia);
    const canCameraBroadcast = Boolean(isSecureContext && hasGetUserMedia);
    const canVoiceIntercom = Boolean(isSecureContext && hasGetUserMedia);

    // 7. Recommended Default Host Mode
    let recommendedHostMode = 'viewer';
    if (canScreenShare) {
        recommendedHostMode = 'screen';
    } else if (canCameraBroadcast) {
        recommendedHostMode = 'camera';
    }

    return Object.freeze({
        isSecureContext,
        hasMediaDevices,
        hasGetUserMedia,
        hasGetDisplayMedia,
        hasWakeLock,
        hasStandardFullscreen,
        hasWebkitFullscreen,
        hasTouch,
        isCoarsePointer,
        isLikelyMobile,
        canScreenShare,
        canCameraBroadcast,
        canVoiceIntercom,
        recommendedHostMode
    });
}

/**
 * Returns user-friendly, actionable diagnostic guidance messages based on detected capability issues.
 * 
 * @param {'insecure_context'|'screen_unsupported'|'permission_denied'|'missing_audio'|'cancelled'|'camera_denied'|'mic_denied'|'connection_failed'} code 
 * @param {object} [details] 
 * @returns {string} Plain-language explanation with next steps.
 */
export function getCapabilityDiagnostics(code, details = {}) {
    switch (code) {
        case 'insecure_context':
            return (
                "Media capture requires a Secure Context (HTTPS or localhost). " +
                "When accessing Streamy over a local home Wi-Fi network, please configure local HTTPS certificates, " +
                "as mobile browsers strictly disable camera, microphone, and screen access on insecure HTTP."
            );

        case 'screen_unsupported':
            return (
                "Screen sharing is not supported by mobile web browsers (such as Safari on iPadOS or Chrome on Android). " +
                "To share a movie with high-fidelity system audio, please host from a desktop computer (Windows, Mac, or Linux). " +
                "You can still broadcast your front/rear camera live, or join as a viewer."
            );

        case 'cancelled':
            return "Screen sharing was cancelled. Click 'Start Broadcast' whenever you are ready to select a screen.";

        case 'missing_audio':
            return (
                "Broadcasting video only. No system audio track was detected. " +
                "To let viewers hear your movie, make sure to check the 'Share system audio' or 'Share tab audio' " +
                "checkbox in the browser screen selection dialog."
            );

        case 'permission_denied':
            return (
                "Media permission was denied by the browser or operating system. " +
                "Please check site permissions in your browser address bar and reload."
            );

        case 'camera_denied':
            return "Camera access was denied. Please allow camera permissions to start a Live Camera broadcast.";

        case 'mic_denied':
            return "Microphone access was denied. Viewers will not be able to hear you on the intercom.";

        case 'connection_failed':
            return (
                "Direct P2P connection could not be established. " +
                "Streaming directly between different networks requires at least one router to permit STUN hole-punching. " +
                "Symmetric NAT (common on cellular hotspots and corporate firewalls) blocks direct UDP traffic."
            );

        default:
            return details.message || `Capability notice: ${code}`;
    }
}
