// src/public/js/modules/core/config.js

/**
 * Direct-P2P WebRTC Configuration (STUN-Assisted, Zero TURN Relay)
 * 
 * Configured strictly for direct peer-to-peer media paths across networks.
 * Uses public STUN servers for server-reflexive (srflx) NAT discovery and direct host candidate pairing.
 * No TURN relay servers are configured or supported in this release.
 */
export const rtcConfiguration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' }
    ],
    iceCandidatePoolSize: 2
};

/**
 * Bitrate profiles for dynamic video stream adaptation and progressive fallback.
 * Uses clean power-of-two scale factors (1.0, 2.0) to prevent fractional or odd
 * YUV 4:2:0 dimensions that can cause black screens on mobile hardware decoders.
 */
export const BITRATE_PROFILES = {
    HD: {
        maxBitrate: 4000000, // 4 Mbps (Cinema / Balanced Motion)
        scaleResolutionDownBy: 1.0,
        maxFramerate: 60,
        degradationPreference: 'balanced',
        label: 'HD'
    },
    ANIME: {
        maxBitrate: 6000000, // 6 Mbps (Razor-sharp 1080p for 2D Anime & Subtitles)
        scaleResolutionDownBy: 1.0,
        maxFramerate: 60,
        degradationPreference: 'maintain-resolution',
        label: 'ANIME'
    },
    BALANCED: {
        maxBitrate: 1800000, // 1.8 Mbps (Smooth 30fps Adaptive Fallback Tier 1)
        scaleResolutionDownBy: 1.0,
        maxFramerate: 30,
        degradationPreference: 'balanced',
        label: 'BALANCED'
    },
    SD: {
        maxBitrate: 800000,  // 800 kbps (Low-bandwidth saver / Fallback Tier 2)
        scaleResolutionDownBy: 2.0,
        maxFramerate: 30,
        degradationPreference: 'balanced',
        label: 'SD'
    },
    FALLBACK: {
        maxBitrate: 450000,  // 450 kbps (Ultra-resilient mobile recovery / Fallback Tier 3)
        scaleResolutionDownBy: 2.0,
        maxFramerate: 24,
        degradationPreference: 'maintain-framerate',
        label: 'FALLBACK'
    }
};

/**
 * Computes a hardware-decoder-safe scaleResolutionDownBy factor so that scaled
 * video dimensions remain even integers (preventing YUV 4:2:0 odd-dimension black screens
 * on mobile SoCs such as Google Pixel Tensor / Exynos when sharing e.g. 1366x768 windows).
 *
 * @param {number} requestedScale - Target scaleResolutionDownBy (e.g. 1.0, 2.0)
 * @param {{width?: number, height?: number}|null} [settings=null] - Video track settings
 * @returns {number} Safe scale factor >= 1.0
 */
export function getSafeScaleResolutionDownBy(requestedScale = 1.0, settings = null) {
    const scale = typeof requestedScale === 'number' && requestedScale >= 1.0 ? requestedScale : 1.0;
    if (scale === 1.0 || !settings) return scale;
    const w = typeof settings.width === 'number' ? settings.width : 0;
    const h = typeof settings.height === 'number' ? settings.height : 0;
    if (w <= 0 || h <= 0) return scale;

    const scaledW = Math.floor(w / scale);
    const scaledH = Math.floor(h / scale);
    if (scaledW % 2 === 0 && scaledH % 2 === 0) {
        return scale;
    }
    // If 2.0 produces an odd dimension (e.g. 1366 / 2 = 683), check if 1.0 is already even
    if (w % 2 === 0 && h % 2 === 0) {
        return 1.0;
    }
    return scale;
}

/**
 * Resolves the appropriate encoding profile for a given fallback tier (0..3) and optimization mode.
 *
 * @param {number} [tier=0] - Fallback tier index (0 = Peak, 1 = Balanced 1.8Mbps, 2 = SD 800kbps, 3 = Ultra-Low 450kbps)
 * @param {'movie'|'anime'} [optMode='movie'] - Stream optimization mode
 * @returns {object} Selected bitrate profile object
 */
export function getAdaptiveFallbackProfile(tier = 0, optMode = 'movie') {
    const clampedTier = typeof tier === 'number' && !Number.isNaN(tier) ? Math.max(0, Math.min(3, Math.floor(tier))) : 0;
    if (clampedTier === 0) {
        return optMode === 'anime' ? BITRATE_PROFILES.ANIME : BITRATE_PROFILES.HD;
    }
    if (clampedTier === 1) {
        return BITRATE_PROFILES.BALANCED;
    }
    if (clampedTier === 2) {
        return BITRATE_PROFILES.SD;
    }
    return BITRATE_PROFILES.FALLBACK;
}

/**
 * Safe, actionable diagnostics for direct-only WebRTC connections.
 * Informs users of NAT / firewall constraints without leaking internal IPs, ports, or credentials.
 * 
 * @param {string} state - The connection or iceConnectionState ('failed', 'disconnected', etc.)
 * @returns {string} User-friendly diagnostic explanation
 */
export function getDirectConnectionDiagnostics(state) {
    switch (state) {
        case 'failed':
            return (
                "Direct P2P connection could not be established. " +
                "Direct streaming between different networks requires that at least one router allows direct NAT traversal (STUN hole-punching). " +
                "If either network uses strict or symmetric NAT (such as cellular hotspots or enterprise firewalls), direct peer-to-peer UDP traffic may be blocked."
            );
        case 'disconnected':
            return "Direct peer connection temporarily interrupted. Waiting for network recovery...";
        case 'closed':
            return "Direct peer connection has been closed.";
        default:
            return `Connection state: ${state}`;
    }
}

export * from './capabilities.js';
