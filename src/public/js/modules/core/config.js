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
        { urls: 'stun:stun1.l.google.com:19302' }
    ],
    iceCandidatePoolSize: 2
};

/**
 * Bitrate profiles for dynamic video stream adaptation.
 */
export const BITRATE_PROFILES = {
    HD: {
        maxBitrate: 4000000, // 4 Mbps (Cinema / Balanced Motion)
        scaleResolutionDownBy: 1.0,
        degradationPreference: 'balanced',
        label: 'HD'
    },
    ANIME: {
        maxBitrate: 6000000, // 6 Mbps (Razor-sharp 1080p for 2D Anime & Subtitles)
        scaleResolutionDownBy: 1.0,
        degradationPreference: 'maintain-resolution',
        label: 'ANIME'
    },
    SD: {
        maxBitrate: 800000,  // 800 kbps (Low-bandwidth saver)
        scaleResolutionDownBy: 1.5,
        degradationPreference: 'balanced',
        label: 'SD'
    }
};

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
