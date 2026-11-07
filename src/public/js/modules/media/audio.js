// src/public/js/modules/media/audio.js

/**
 * Streamy Pro — Hardened Audio Engine
 * 
 * Provides:
 * 1. RFC 4566 compliant SDP Opus stereo / high-bitrate negotiation without parameter duplication.
 * 2. Click-free volume ramping with cosine ease-in-out curves.
 * 3. Authoritative DuckingController:
 *    - Independent tracking of userPreferredVolume.
 *    - Manual volume adjustment preservation during ducking.
 *    - Multi-speaker tracking with 1.2s silence debounce to eliminate oscillations.
 *    - Full lifecycle disposal (AudioContext, Analyser, nodes, timers, listeners).
 * 4. Dialogue Compressor / Night Mode:
 *    - Eliminates duplicate audio playout by keeping only one audible pipeline active.
 *    - Clean teardown with zero AudioContext or DOM leaks.
 * 5. Lightweight, opt-in local audio diagnostics (tracks, transceivers, codecs, packet loss, jitter, bitrate delta).
 */

/**
 * Parses an SDP string into session-level lines and individual media sections (m= blocks)
 * adhering to RFC 4566 / RFC 8866.
 * 
 * @param {string} sdp - Raw SDP string.
 * @returns {{ sessionLines: string[], mediaSections: Array<{ mediaType: string, headerLine: string, lines: string[], mid: string|null, direction: string|null }> }}
 */
export function parseSDPSections(sdp) {
    if (!sdp || typeof sdp !== 'string') {
        return { sessionLines: [], mediaSections: [] };
    }

    const rawLines = sdp.split(/\r?\n/).filter(line => line.length > 0);
    const sessionLines = [];
    const mediaSections = [];
    let currentSection = null;

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (line.startsWith('m=')) {
            if (currentSection) {
                mediaSections.push(currentSection);
            }
            const match = line.match(/^m=([^\s]+)(?:\s+(\d+))?/);
            const mediaType = match ? match[1].toLowerCase() : '';
            const port = match && match[2] ? parseInt(match[2], 10) : null;
            currentSection = {
                mediaType,
                port,
                headerLine: line,
                lines: [line],
                mid: null,
                direction: null
            };
        } else if (currentSection) {
            currentSection.lines.push(line);
            const trimmed = line.trim();
            if (trimmed.startsWith('a=mid:')) {
                currentSection.mid = trimmed.substring(6).trim();
            } else if (trimmed === 'a=sendonly' || trimmed === 'a=recvonly' || trimmed === 'a=sendrecv' || trimmed === 'a=inactive') {
                currentSection.direction = trimmed.substring(2);
            }
        } else {
            sessionLines.push(line);
        }
    }
    if (currentSection) {
        mediaSections.push(currentSection);
    }

    return { sessionLines, mediaSections };
}

/**
 * Helper to retrieve the MID string for a specific 0-based media section index.
 * Useful before setLocalDescription when transceiver.mid is not yet populated.
 * 
 * @param {string} sdp - Raw SDP string.
 * @param {number} sectionIndex - 0-based media section index.
 * @returns {string|null} The section's MID, or null if unassigned or out of range.
 */
export function getMidForSectionIndex(sdp, sectionIndex) {
    if (!sdp || typeof sdp !== 'string' || typeof sectionIndex !== 'number' || sectionIndex < 0) {
        return null;
    }
    const { mediaSections } = parseSDPSections(sdp);
    if (sectionIndex < mediaSections.length) {
        return mediaSections[sectionIndex].mid;
    }
    return null;
}

/**
 * Helper to enhance the lines of a single targeted media section for Opus stereo / high bitrate.
 * 
 * @param {string[]} lines - Lines of the media section.
 * @returns {string[]} Enhanced lines.
 */
function enhanceSectionLines(lines) {
    const opusPayloadTypes = new Set();
    lines.forEach(line => {
        const match = line.match(/^a=rtpmap:(\d+)\s+opus\/48000\/2/i);
        if (match) {
            opusPayloadTypes.add(match[1]);
        }
    });

    if (opusPayloadTypes.size === 0) {
        return [...lines];
    }

    const processedPayloadTypes = new Set();
    const resultLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check for existing a=fmtp:<pt> lines for Opus
        let isFmtpLine = false;
        for (const pt of opusPayloadTypes) {
            const fmtpPrefix = `a=fmtp:${pt} `;
            if (line.startsWith(fmtpPrefix)) {
                isFmtpLine = true;
                processedPayloadTypes.add(pt);

                // Parse existing semicolon-delimited parameters into a key-value map
                const paramString = line.substring(fmtpPrefix.length).trim();
                const paramEntries = paramString.split(';').map(p => p.trim()).filter(Boolean);
                const paramMap = new Map();

                paramEntries.forEach(entry => {
                    const eqIdx = entry.indexOf('=');
                    if (eqIdx !== -1) {
                        const key = entry.substring(0, eqIdx).trim().toLowerCase();
                        const val = entry.substring(eqIdx + 1).trim();
                        paramMap.set(key, val);
                    } else {
                        paramMap.set(entry.toLowerCase(), '');
                    }
                });

                // Enforce studio-grade stereo parameters without duplication or conflict
                paramMap.set('stereo', '1');
                paramMap.set('sprop-stereo', '1');
                paramMap.set('maxaveragebitrate', '128000');

                const newParamString = Array.from(paramMap.entries())
                    .map(([k, v]) => (v !== '' ? `${k}=${v}` : k))
                    .join(';');

                resultLines.push(`a=fmtp:${pt} ${newParamString}`);
                break;
            }
        }

        if (!isFmtpLine) {
            resultLines.push(line);

            // If this line is the a=rtpmap line for an Opus PT that had no existing a=fmtp line, insert one immediately
            for (const pt of opusPayloadTypes) {
                if (line.match(new RegExp(`^a=rtpmap:${pt}\\s+opus\\/48000\\/2`, 'i'))) {
                    // Peek ahead: only insert if next line is not an fmtp for this pt
                    const nextLine = lines[i + 1];
                    if (!nextLine || !nextLine.startsWith(`a=fmtp:${pt} `)) {
                        resultLines.push(`a=fmtp:${pt} stereo=1;sprop-stereo=1;maxaveragebitrate=128000`);
                        processedPayloadTypes.add(pt);
                    }
                }
            }
        }
    }

    return resultLines;
}

/**
 * Modifies WebRTC SDP to negotiate high-fidelity Opus stereo parameters (48 kHz, 128 kbps)
 * strictly scoped to the intended programme-audio media section.
 * Preserves existing valid parameters, avoids duplicate or contradictory fmtp entries,
 * leaves voice-intercom sections untouched, normalizes CRLF line endings, and is strictly idempotent.
 * 
 * Strict targeting rules:
 * - When an explicit target (targetMid or targetSectionIndex) is supplied, only that section may be enhanced.
 * - If an explicitly targeted section does not exist, is video, or is inactive, NO section is modified.
 * - Legacy fallback (first sendonly audio section or single audio section) executes ONLY when no explicit target is supplied.
 * 
 * @param {string} sdp - Original WebRTC SDP offer/answer string.
 * @param {object|string|number} [options] - Target options or MID string/number.
 * @param {string} [options.targetMid] - MID of the specific media section to enhance (e.g. '1', 'audio-prog').
 * @param {number} [options.targetSectionIndex] - 0-based media section index to enhance.
 * @param {boolean} [options.skip=false] - If true, skips enhancement and returns normalized SDP.
 * @returns {string} Enhanced SDP string.
 */
export function enhanceSDP(sdp, options = {}) {
    if (!sdp || typeof sdp !== 'string') return sdp;

    const { sessionLines, mediaSections } = parseSDPSections(sdp);
    if (mediaSections.length === 0) {
        // Session-only or malformed SDP without media sections
        const lines = sdp.split(/\r?\n/).filter(line => line.length > 0);
        return lines.join('\r\n') + '\r\n';
    }

    // Determine if caller provided an explicit targeting instruction
    const isExplicitTarget = Boolean(
        options !== null && (
            typeof options === 'string' ||
            typeof options === 'number' ||
            (typeof options === 'object' && (
                options.targetMid !== undefined ||
                options.targetSectionIndex !== undefined ||
                options.skip === true
            ))
        )
    );

    let targetSection = null;

    if (isExplicitTarget) {
        // ---------------------------------------------------------
        // STRICT EXPLICIT TARGETING MODE
        // An explicit target MUST be resolved to an active audio section.
        // If the target is missing, out-of-range, video, or inactive,
        // NO fallback is permitted; the SDP MUST remain unchanged.
        // ---------------------------------------------------------
        if (typeof options === 'object' && options.skip === true) {
            const lines = sdp.split(/\r?\n/).filter(line => line.length > 0);
            return lines.join('\r\n') + '\r\n';
        }

        let explicitMid = null;
        let explicitIndex = null;

        if (typeof options === 'string' || typeof options === 'number') {
            explicitMid = String(options).trim();
        } else if (typeof options === 'object') {
            if (options.targetMid !== undefined && options.targetMid !== null) {
                explicitMid = String(options.targetMid).trim();
            }
            if (options.targetSectionIndex !== undefined && options.targetSectionIndex !== null) {
                const idx = typeof options.targetSectionIndex === 'number'
                    ? options.targetSectionIndex
                    : Number(options.targetSectionIndex);
                if (Number.isInteger(idx)) {
                    explicitIndex = idx;
                } else {
                    explicitIndex = -1; // Out of range / invalid index
                }
            }
        }

        if (explicitMid !== null) {
            targetSection = (explicitMid !== '' ? mediaSections.find(s => s.mid === explicitMid) : null) || null;
        } else if (explicitIndex !== null) {
            if (explicitIndex >= 0 && explicitIndex < mediaSections.length) {
                targetSection = mediaSections[explicitIndex];
            } else {
                targetSection = null; // Out of range explicit index
            }
        }

        // Validate suitability of explicit target: must be an active audio section
        // Nonexistent, video, inactive direction, or rejected port 0 are unsuitable
        if (!targetSection || targetSection.mediaType !== 'audio' || targetSection.direction === 'inactive' || targetSection.port === 0) {
            // Unsuitable or nonexistent explicit target: return normalized SDP without modifying any section
            const lines = sdp.split(/\r?\n/).filter(line => line.length > 0);
            return lines.join('\r\n') + '\r\n';
        }
    } else {
        // ---------------------------------------------------------
        // LEGACY / DEFAULT COMPATIBILITY FALLBACK
        // Runs ONLY when caller provided no targeting arguments at all.
        // ---------------------------------------------------------
        const audioSections = mediaSections.filter(s => s.mediaType === 'audio' && s.direction !== 'inactive' && s.port !== 0);
        if (audioSections.length === 1) {
            // Exactly 1 audio section: enhance it for backward compatibility with single-lane callers
            targetSection = audioSections[0];
        } else if (audioSections.length > 1) {
            // Multiple audio sections:
            // Programme audio in Streamy Pro is sendonly; voice intercom is sendrecv or recvonly.
            targetSection = audioSections.find(s => s.direction === 'sendonly') || audioSections[0];
        }
    }

    if (!targetSection) {
        const lines = sdp.split(/\r?\n/).filter(line => line.length > 0);
        return lines.join('\r\n') + '\r\n';
    }

    // Reconstruct SDP lines with strictly targeted section enhancement
    const outputLines = [...sessionLines];

    for (const section of mediaSections) {
        if (section === targetSection) {
            outputLines.push(...enhanceSectionLines(section.lines));
        } else {
            outputLines.push(...section.lines);
        }
    }

    return outputLines.join('\r\n') + '\r\n';
}

/**
 * Resolves the explicit targeting parameter ({ targetMid } or { targetSectionIndex }) for the
 * broadcaster's programme-audio transceiver lane.
 * 
 * Inspects the peer connection transceivers to identify the transceiver associated with progTrack,
 * and determines its MID or media section index in the offer SDP.
 * 
 * Returns null if progTrack is absent, if the transceiver cannot be found,
 * or if neither MID nor a valid 0-based index can be resolved.
 * Never defaults to voice intercom or any other lane.
 * 
 * @param {string} offerSdp - Raw SDP offer string.
 * @param {MediaStreamTrack|null} progTrack - The programme audio track.
 * @param {RTCPeerConnection|Array<RTCRtpTransceiver>} pcOrTransceivers - PeerConnection or transceivers array.
 * @returns {{ targetMid: string } | { targetSectionIndex: number } | null} Target options or null if unmappable.
 */
export function resolveProgrammeAudioTarget(offerSdp, progTrack, pcOrTransceivers) {
    if (!offerSdp || !progTrack) {
        return null;
    }
    const transceivers = Array.isArray(pcOrTransceivers)
        ? pcOrTransceivers
        : (pcOrTransceivers && typeof pcOrTransceivers.getTransceivers === 'function' ? pcOrTransceivers.getTransceivers() : []);

    const progTransceiver = transceivers.find(t => t && t.sender && t.sender.track === progTrack);
    if (!progTransceiver) {
        return null;
    }

    let targetMid = progTransceiver.mid;
    const progIdx = transceivers.indexOf(progTransceiver);

    if (!targetMid && progIdx >= 0) {
        targetMid = getMidForSectionIndex(offerSdp, progIdx);
    }

    if (targetMid) {
        return { targetMid };
    } else if (progIdx >= 0) {
        return { targetSectionIndex: progIdx };
    }

    return null;
}

/**
 * Scopes SDP enhancement strictly to the programme-audio transceiver lane for broadcaster offers.
 * If programme audio is absent or mapping fails, returns the original SDP completely unmodified.
 * Never calls enhanceSDP without an explicit, resolved target.
 * 
 * @param {string} offerSdp - Raw SDP offer string.
 * @param {MediaStreamTrack|null} progTrack - The programme audio track.
 * @param {RTCPeerConnection|Array<RTCRtpTransceiver>} pcOrTransceivers - PeerConnection or transceivers array.
 * @returns {string} Enhanced SDP, or original offer SDP unchanged on mapping failure.
 */
export function enhanceBroadcasterOffer(offerSdp, progTrack, pcOrTransceivers) {
    if (!offerSdp || !progTrack) {
        return offerSdp;
    }
    const target = resolveProgrammeAudioTarget(offerSdp, progTrack, pcOrTransceivers);
    if (!target) {
        return offerSdp;
    }
    return enhanceSDP(offerSdp, target);
}

/**
 * Smoothly transitions the volume of an HTMLMediaElement between two levels over a duration.
 * Uses a cosine ease-in-out curve to prevent clicks, pops, and sudden jumps.
 * 
 * @param {HTMLMediaElement} mediaElement 
 * @param {number} targetVolume - Target volume [0.0 - 1.0].
 * @param {number} [durationMs=150] - Duration in milliseconds.
 * @param {Function} [onComplete] - Callback on completion.
 */
export function rampMediaVolume(mediaElement, targetVolume, durationMs = 150, onComplete = null) {
    if (!mediaElement) return;

    if (mediaElement._volumeRampTimer) {
        clearInterval(mediaElement._volumeRampTimer);
        mediaElement._volumeRampTimer = null;
    }

    const startVolume = mediaElement.volume;
    const clampedTarget = Math.max(0, Math.min(1, targetVolume));

    // If already at target or duration is 0, set immediately
    if (Math.abs(startVolume - clampedTarget) < 0.005 || durationMs <= 0) {
        mediaElement._isRampingVolume = true;
        try {
            mediaElement.volume = clampedTarget;
        } finally {
            queueMicrotask(() => { mediaElement._isRampingVolume = false; });
        }
        if (typeof onComplete === 'function') onComplete();
        return;
    }

    const stepInterval = 20; // 50 updates per second
    const totalSteps = Math.max(1, Math.floor(durationMs / stepInterval));
    let currentStep = 0;

    mediaElement._volumeRampTimer = setInterval(() => {
        currentStep++;
        const progress = currentStep / totalSteps;
        // Cosine ease-in-out factor [0.0 -> 1.0]
        const factor = (1 - Math.cos(progress * Math.PI)) / 2;
        const newVol = startVolume + (clampedTarget - startVolume) * factor;

        mediaElement._isRampingVolume = true;
        try {
            mediaElement.volume = Math.max(0, Math.min(1, newVol));
        } finally {
            mediaElement._isRampingVolume = false;
        }

        if (currentStep >= totalSteps) {
            mediaElement._isRampingVolume = true;
            try {
                mediaElement.volume = clampedTarget;
            } finally {
                queueMicrotask(() => { mediaElement._isRampingVolume = false; });
            }
            clearInterval(mediaElement._volumeRampTimer);
            mediaElement._volumeRampTimer = null;
            if (typeof onComplete === 'function') onComplete();
        }
    }, stepInterval);
}

/**
 * Authoritative Ducking Controller.
 * 
 * Invariants:
 * 1. Independently tracks userPreferredVolume separate from temporary ducked volume.
 * 2. If the user adjusts volume while ducking is active, updates user preference rather than restoring to a stale value.
 * 3. Aggregates multiple incoming voice streams into a unified ducking state without volume re-clamping.
 * 4. Silence release uses a 1.2s debounce to prevent voice-chopping and rapid duck/restore oscillation.
 * 5. Full resource disposal (AudioContext, Analyser, nodes, timers, listeners).
 */
export class DuckingController {
    /**
     * @param {HTMLMediaElement} mediaElement - The media element playing programme/movie audio (#mainVideo).
     * @param {object} [options]
     * @param {number} [options.duckRatio=0.3] - Ducking multiplier (default 0.3 = 30% of preferred volume).
     * @param {number} [options.minDuckedVolume=0.05] - Lower floor for audible ducked audio.
     * @param {number} [options.thresholdRms=0.02] - RMS threshold for speech detection.
     * @param {number} [options.silenceDelayMs=1200] - Silence delay before volume restoration.
     * @param {number} [options.duckRampMs=150] - Duration of ducking transition.
     * @param {number} [options.restoreRampMs=400] - Duration of restoration transition.
     */
    constructor(mediaElement, options = {}) {
        this.mediaElement = mediaElement;
        this.duckRatio = options.duckRatio ?? 0.3;
        this.minDuckedVolume = options.minDuckedVolume ?? 0.05;
        this.thresholdRms = options.thresholdRms ?? 0.02;
        this.silenceDelayMs = options.silenceDelayMs ?? 1200;
        this.duckRampMs = options.duckRampMs ?? 150;
        this.restoreRampMs = options.restoreRampMs ?? 400;

        // User's baseline volume preference
        this.userPreferredVolume = mediaElement && mediaElement.volume > 0 ? mediaElement.volume : 1.0;
        this.targetDuckedVolume = null;
        this.isDucked = false;
        this.isDestroyed = false;

        // Map of speakerId -> { track, audioCtx, source, analyser, fallbackGain, audioElement, animId, silenceTimer, isSpeaking, onSpeechChange, endedHandler }
        this.speakers = new Map();
        this.activeSpeakers = new Set();
        this.restoreTimeout = null;
        this.sharedAudioCtx = null;

        // Monitor user volume adjustments on the media element
        this._volumeChangeListener = () => {
            if (this.isDestroyed || !this.mediaElement) return;
            if (this.mediaElement._isRampingVolume) return;

            const currentVol = this.mediaElement.volume;

            if (this.isDucked) {
                // Ignore volume changes that match the target ducked volume or restored preferred volume
                if (this.targetDuckedVolume !== null && Math.abs(currentVol - this.targetDuckedVolume) < 0.01) {
                    return;
                }
                if (Math.abs(currentVol - this.userPreferredVolume) < 0.01) {
                    return;
                }

                // User interacted with volume control while ducking was active.
                // Store their explicit preference, and keep ducked level proportional.
                this.userPreferredVolume = currentVol;
                this.targetDuckedVolume = Math.max(this.minDuckedVolume, this.userPreferredVolume * this.duckRatio);
                this.mediaElement._isRampingVolume = true;
                try {
                    this.mediaElement.volume = this.targetDuckedVolume;
                } finally {
                    queueMicrotask(() => { if (this.mediaElement) this.mediaElement._isRampingVolume = false; });
                }
            } else {
                if (Math.abs(currentVol - this.userPreferredVolume) < 0.01) {
                    return;
                }
                this.userPreferredVolume = currentVol;
            }
        };

        if (this.mediaElement) {
            this.mediaElement.addEventListener('volumechange', this._volumeChangeListener);
        }
    }

    /**
     * Unlocks and resumes the shared AudioContext during a user gesture (e.g. START BROADCAST, JOIN MOVIE, #micBtn).
     */
    resumeContext() {
        if (this.isDestroyed) return;
        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (AudioContextClass && (!this.sharedAudioCtx || this.sharedAudioCtx.state === 'closed')) {
                this.sharedAudioCtx = new AudioContextClass();
                this.sharedAudioCtx.addEventListener('statechange', () => {
                    if (!this.isDestroyed && this.sharedAudioCtx && (this.sharedAudioCtx.state === 'suspended' || this.sharedAudioCtx.state === 'interrupted')) {
                        this.sharedAudioCtx.resume().catch(() => { });
                    }
                });
            }
            if (this.sharedAudioCtx && this.sharedAudioCtx.state !== 'running' && this.sharedAudioCtx.state !== 'closed') {
                this.sharedAudioCtx.resume().catch(() => { });
            }
            this.speakers.forEach(rec => {
                if (rec.audioCtx && rec.audioCtx.state !== 'running' && rec.audioCtx.state !== 'closed') {
                    rec.audioCtx.resume().catch(() => { });
                }
            });
        } catch (e) { }
    }

    /**
     * Registers an incoming participant voice track to be monitored for speech activity
     * and provides automatic Web Audio playout fallback if the DOM <audio> element is blocked by mobile autoplay policy.
     * 
     * @param {string} speakerId - Unique ID of the speaking peer.
     * @param {MediaStreamTrack} voiceTrack - Incoming audio track.
     * @param {Function} [onSpeechChange] - Optional callback(isSpeaking: boolean).
     * @param {HTMLMediaElement} [audioElement] - Optional DOM <audio> element playing the voice track.
     */
    registerVoiceTrack(speakerId, voiceTrack, onSpeechChange = null, audioElement = null) {
        if (this.isDestroyed || !voiceTrack) return;

        // If the exact same track is already registered for this speaker, update references without tearing down nodes
        if (this.speakers.has(speakerId)) {
            const existing = this.speakers.get(speakerId);
            if (existing && existing.track === voiceTrack) {
                if (onSpeechChange) existing.onSpeechChange = onSpeechChange;
                if (audioElement) existing.audioElement = audioElement;
                this.resumeContext();
                return;
            }
            this.unregisterVoiceTrack(speakerId);
        }

        const speakerRecord = {
            track: voiceTrack,
            audioCtx: null,
            ownsContext: false,
            source: null,
            analyser: null,
            fallbackGain: null,
            audioElement: audioElement || null,
            animId: null,
            silenceTimer: null,
            isSpeaking: false,
            onSpeechChange,
            endedHandler: null
        };

        const handleTrackEnded = () => {
            this.unregisterVoiceTrack(speakerId, voiceTrack);
        };
        voiceTrack.addEventListener('ended', handleTrackEnded);
        speakerRecord.endedHandler = handleTrackEnded;

        try {
            const AudioContextClass = window.AudioContext || window.webkitAudioContext;
            if (!AudioContextClass) {
                this.speakers.set(speakerId, speakerRecord);
                return;
            }

            if (!this.sharedAudioCtx || this.sharedAudioCtx.state === 'closed') {
                this.sharedAudioCtx = new AudioContextClass();
                this.sharedAudioCtx.addEventListener('statechange', () => {
                    if (!this.isDestroyed && this.sharedAudioCtx && (this.sharedAudioCtx.state === 'suspended' || this.sharedAudioCtx.state === 'interrupted')) {
                        this.sharedAudioCtx.resume().catch(() => { });
                    }
                });
            }
            const audioCtx = this.sharedAudioCtx;
            if (audioCtx.state !== 'running') {
                audioCtx.resume().catch(() => { });
            }
            speakerRecord.audioCtx = audioCtx;
            speakerRecord.ownsContext = false;

            const source = audioCtx.createMediaStreamSource(new MediaStream([voiceTrack]));
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.3;

            // Connect analyser -> fallbackGain -> destination so:
            // 1. WebKit/Chromium pull-graphs continuously pull WebRTC audio samples through the analyser.
            // 2. If the DOM <audio> element is paused/blocked by mobile autoplay policy, fallbackGain outputs the voice audibly.
            // 3. When the DOM <audio> element is actively playing, fallbackGain is 0.0 (preventing double playout while preserving native AEC).
            const fallbackGain = audioCtx.createGain();
            fallbackGain.gain.value = 0;

            source.connect(analyser);
            analyser.connect(fallbackGain);
            fallbackGain.connect(audioCtx.destination);

            speakerRecord.source = source;
            speakerRecord.analyser = analyser;
            speakerRecord.fallbackGain = fallbackGain;

            const timeData = new Uint8Array(analyser.frequencyBinCount);

            const loop = () => {
                if (this.isDestroyed || !this.speakers.has(speakerId)) return;

                if (speakerRecord.fallbackGain && speakerRecord.audioElement) {
                    const el = speakerRecord.audioElement;
                    const domPlaying = !el.paused && !el.muted && el.readyState >= 2;
                    const targetGain = domPlaying ? 0 : 1;
                    if (speakerRecord.fallbackGain.gain.value !== targetGain) {
                        speakerRecord.fallbackGain.gain.value = targetGain;
                    }
                }

                analyser.getByteTimeDomainData(timeData);

                // Compute true Root Mean Square (RMS) of audio waveform
                let sumSquares = 0;
                for (let i = 0; i < timeData.length; i++) {
                    const normalized = (timeData[i] - 128) / 128;
                    sumSquares += normalized * normalized;
                }
                const rms = Math.sqrt(sumSquares / timeData.length);

                if (rms > this.thresholdRms) {
                    if (!speakerRecord.isSpeaking) {
                        speakerRecord.isSpeaking = true;
                        if (speakerRecord.onSpeechChange) speakerRecord.onSpeechChange(true);
                    }
                    if (speakerRecord.silenceTimer) {
                        clearTimeout(speakerRecord.silenceTimer);
                        speakerRecord.silenceTimer = null;
                    }
                    this._onSpeakerVoiceActive(speakerId);
                } else if (speakerRecord.isSpeaking && !speakerRecord.silenceTimer) {
                    // Speaker-local 300ms silence detection before marking inactive
                    speakerRecord.silenceTimer = setTimeout(() => {
                        speakerRecord.silenceTimer = null;
                        if (this.isDestroyed || !this.speakers.has(speakerId)) return;
                        speakerRecord.isSpeaking = false;
                        if (speakerRecord.onSpeechChange) speakerRecord.onSpeechChange(false);
                        this._onSpeakerVoiceSilence(speakerId);
                    }, 300);
                }

                speakerRecord.animId = requestAnimationFrame(loop);
            };

            speakerRecord.animId = requestAnimationFrame(loop);
        } catch (e) {
            console.warn(`[Audio] Failed to setup analyser for speaker ${speakerId}:`, e);
        }

        this.speakers.set(speakerId, speakerRecord);
    }

    /**
     * Unregisters an incoming voice track and cleans up its audio resources.
     * 
     * @param {string} speakerId 
     * @param {MediaStreamTrack} [expectedTrack] - If supplied, only unregisters if current track matches.
     */
    unregisterVoiceTrack(speakerId, expectedTrack = null) {
        const record = this.speakers.get(speakerId);
        if (!record) return;
        if (expectedTrack && record.track !== expectedTrack) return;

        this.speakers.delete(speakerId);
        this.activeSpeakers.delete(speakerId);

        if (record.animId) {
            cancelAnimationFrame(record.animId);
            record.animId = null;
        }
        if (record.silenceTimer) {
            clearTimeout(record.silenceTimer);
            record.silenceTimer = null;
        }
        if (record.endedHandler && record.track) {
            record.track.removeEventListener('ended', record.endedHandler);
            record.endedHandler = null;
        }
        try { if (record.source) record.source.disconnect(); } catch (e) { }
        try { if (record.analyser) record.analyser.disconnect(); } catch (e) { }
        try { if (record.fallbackGain) record.fallbackGain.disconnect(); } catch (e) { }
        record.source = null;
        record.analyser = null;
        record.fallbackGain = null;
        if (record.audioCtx && record.ownsContext) {
            record.audioCtx.close().catch(() => { });
        }
        record.audioCtx = null;
        if (record.onSpeechChange) {
            record.onSpeechChange(false);
        }

        // If no active speakers remain, schedule volume restoration
        if (this.activeSpeakers.size === 0 && this.isDucked) {
            this._scheduleRestore();
        }
    }

    /**
     * Internal handler when a registered speaker's voice is actively detected.
     * 
     * @param {string} speakerId 
     * @private
     */
    _onSpeakerVoiceActive(speakerId) {
        this.activeSpeakers.add(speakerId);

        // Cancel any pending restoration timer
        if (this.restoreTimeout) {
            clearTimeout(this.restoreTimeout);
            this.restoreTimeout = null;
        }

        // Duck volume if not already ducked
        if (!this.isDucked && this.mediaElement) {
            this.isDucked = true;
            this.targetDuckedVolume = Math.max(this.minDuckedVolume, this.userPreferredVolume * this.duckRatio);
            rampMediaVolume(this.mediaElement, this.targetDuckedVolume, this.duckRampMs);
        }
    }

    /**
     * Internal handler when a registered speaker becomes silent.
     * 
     * @param {string} speakerId 
     * @private
     */
    _onSpeakerVoiceSilence(speakerId) {
        this.activeSpeakers.delete(speakerId);

        // When all active speakers are silent, begin debounce timer
        if (this.activeSpeakers.size === 0 && this.isDucked) {
            this._scheduleRestore();
        }
    }

    /**
     * Schedules smooth restoration of userPreferredVolume after silence debounce period.
     * @private
     */
    _scheduleRestore() {
        if (this.restoreTimeout) clearTimeout(this.restoreTimeout);
        this.restoreTimeout = setTimeout(() => {
            this.restoreTimeout = null;
            if (this.isDestroyed || !this.isDucked || this.activeSpeakers.size > 0 || !this.mediaElement) return;

            this.isDucked = false;
            this.targetDuckedVolume = null;
            rampMediaVolume(this.mediaElement, this.userPreferredVolume, this.restoreRampMs);
        }, this.silenceDelayMs);
    }

    /**
     * Fully disposes of the DuckingController, releasing all audio contexts, nodes, listeners, and timers.
     */
    destroy() {
        if (this.isDestroyed) return;
        this.isDestroyed = true;

        if (this.restoreTimeout) {
            clearTimeout(this.restoreTimeout);
            this.restoreTimeout = null;
        }

        // Unregister all speakers
        const speakerIds = Array.from(this.speakers.keys());
        speakerIds.forEach(id => this.unregisterVoiceTrack(id));

        if (this.sharedAudioCtx) {
            this.sharedAudioCtx.close().catch(() => { });
            this.sharedAudioCtx = null;
        }

        if (this.mediaElement) {
            if (this.mediaElement._volumeRampTimer) {
                clearInterval(this.mediaElement._volumeRampTimer);
                this.mediaElement._volumeRampTimer = null;
            }
            this.mediaElement.removeEventListener('volumechange', this._volumeChangeListener);

            // Restore user preferred volume if still attached
            if (this.isDucked) {
                this.mediaElement._isRampingVolume = true;
                try {
                    this.mediaElement.volume = this.userPreferredVolume;
                } finally {
                    this.mediaElement._isRampingVolume = false;
                }
            }
        }

        this.isDucked = false;
        this.activeSpeakers.clear();
    }
}

/**
 * Backward-compatible helper for single-track native ducking.
 * Uses DuckingController under the hood.
 * 
 * @param {MediaStreamTrack} voiceTrack 
 * @param {HTMLMediaElement} mediaElement 
 * @param {Function} [onSpeechChange] 
 * @returns {object} Controller with destroy() method.
 */
export function setupNativeDucking(voiceTrack, mediaElement, onSpeechChange = null) {
    if (!voiceTrack || !mediaElement) return { destroy: () => { } };

    // Attach or reuse controller on mediaElement
    let controller = mediaElement._duckingController;
    let ownsController = false;

    if (!controller || controller.isDestroyed) {
        controller = new DuckingController(mediaElement);
        mediaElement._duckingController = controller;
        ownsController = true;
    }

    const speakerId = 'peer_' + Math.random().toString(36).substring(2, 9);
    controller.registerVoiceTrack(speakerId, voiceTrack, onSpeechChange);

    return {
        destroy: () => {
            if (controller && !controller.isDestroyed) {
                controller.unregisterVoiceTrack(speakerId);
                if (ownsController && controller.speakers.size === 0) {
                    controller.destroy();
                    mediaElement._duckingController = null;
                }
            }
        }
    };
}

/**
 * Monitors local mic track to provide speaking activity callbacks for local UI controls.
 * 
 * @param {MediaStreamTrack} micTrack - Local mic audio track.
 * @param {Function} onSpeakingChange - Callback(isSpeaking: boolean).
 * @returns {object} Controller with destroy() method.
 */
export function setupLocalMicMonitor(micTrack, onSpeakingChange) {
    if (!micTrack || !onSpeakingChange) return { destroy: () => { } };

    let isDestroyed = false;
    let animId = null;
    let silenceTimer = null;
    let audioCtx = null;
    let isSpeaking = false;

    const destroy = () => {
        if (isDestroyed) return;
        isDestroyed = true;
        if (animId) {
            cancelAnimationFrame(animId);
            animId = null;
        }
        if (silenceTimer) {
            clearTimeout(silenceTimer);
            silenceTimer = null;
        }
        if (micTrack) {
            micTrack.removeEventListener('ended', destroy);
        }
        if (audioCtx) {
            audioCtx.close().catch(() => { });
            audioCtx = null;
        }
        onSpeakingChange(false);
    };

    micTrack.addEventListener('ended', destroy);

    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return { destroy };

        audioCtx = new AudioContextClass();
        if (audioCtx.state !== 'running') audioCtx.resume().catch(() => { });
        audioCtx.addEventListener('statechange', () => {
            if (!isDestroyed && audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
                audioCtx.resume().catch(() => { });
            }
        });

        const source = audioCtx.createMediaStreamSource(new MediaStream([micTrack]));
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const zeroGain = audioCtx.createGain();
        zeroGain.gain.value = 0;
        source.connect(analyser);
        analyser.connect(zeroGain);
        zeroGain.connect(audioCtx.destination);

        const data = new Uint8Array(analyser.frequencyBinCount);

        const loop = () => {
            if (isDestroyed) return;
            analyser.getByteTimeDomainData(data);

            let sum = 0;
            for (let i = 0; i < data.length; i++) {
                const norm = (data[i] - 128) / 128;
                sum += norm * norm;
            }
            const rms = Math.sqrt(sum / data.length);

            if (rms > 0.02) {
                if (!isSpeaking) {
                    isSpeaking = true;
                    onSpeakingChange(true);
                }
                if (silenceTimer) clearTimeout(silenceTimer);
                silenceTimer = setTimeout(() => {
                    if (isDestroyed) return;
                    isSpeaking = false;
                    onSpeakingChange(false);
                }, 800);
            }

            animId = requestAnimationFrame(loop);
        };

        animId = requestAnimationFrame(loop);
    } catch (e) {
        console.warn("[Audio] Local mic monitor error:", e);
    }

    return { destroy };
}

/**
 * Dialogue Compressor / Night Mode.
 * 
 * Compresses dynamic range so quiet dialogue is clear while explosions are moderated.
 * To prevent dual playout, the raw videoElement output is muted while compressed audio
 * plays via the dedicated DOM-mounted player, with volume synchronized.
 * 
 * @param {HTMLVideoElement} videoElement - The main video player containing movie audio.
 * @returns {object|null} Controller with destroy() method, or null if setup fails.
 */
export function setupDialogueCompressor(videoElement) {
    if (!videoElement || !videoElement.srcObject) return null;
    const audioTrack = videoElement.srcObject.getAudioTracks()[0];
    if (!audioTrack) return null;

    if (typeof videoElement._dialogueCompressorDestroy === 'function') {
        videoElement._dialogueCompressorDestroy();
    }

    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;

        const audioCtx = new AudioContextClass();
        if (audioCtx.state !== 'running') audioCtx.resume().catch(() => { });
        audioCtx.addEventListener('statechange', () => {
            if (audioCtx && (audioCtx.state === 'suspended' || audioCtx.state === 'interrupted')) {
                audioCtx.resume().catch(() => { });
            }
        });

        const stream = new MediaStream([audioTrack]);
        const mediaSource = audioCtx.createMediaStreamSource(stream);

        const compressor = audioCtx.createDynamicsCompressor();
        compressor.threshold.value = -40; // Compress above -40 dB
        compressor.knee.value = 30;
        compressor.ratio.value = 12;      // Heavy flattening ratio
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        const aecDest = audioCtx.createMediaStreamDestination();
        mediaSource.connect(compressor);
        let makeupGain = null;
        if (typeof audioCtx.createGain === 'function') {
            makeupGain = audioCtx.createGain();
            const initVol = videoElement._userExplicitlyMuted ? 0 : (typeof videoElement.volume === 'number' ? videoElement.volume : 1.0);
            makeupGain.gain.value = 1.35 * initVol; // Boost quiet dialogue & scale software volume for iOS/iPadOS where HTMLMediaElement.volume is read-only
            compressor.connect(makeupGain);
            makeupGain.connect(aecDest);
        } else {
            compressor.connect(aecDest);
        }

        let aecPlayer = document.getElementById('viewerAecPlayer');
        if (!aecPlayer) {
            aecPlayer = new Audio();
            aecPlayer.id = 'viewerAecPlayer';
            document.body.appendChild(aecPlayer);
        }
        aecPlayer.autoplay = true;
        aecPlayer.playsInline = true;
        aecPlayer.setAttribute('playsinline', '');
        aecPlayer.setAttribute('webkit-playsinline', '');
        aecPlayer.srcObject = aecDest.stream;
        aecPlayer.volume = videoElement.volume;
        aecPlayer.muted = Boolean(videoElement._userExplicitlyMuted);

        // Prevent dual audio playback: mute video element while compressor plays
        let restoreMuted = videoElement._userExplicitlyMuted !== undefined
            ? Boolean(videoElement._userExplicitlyMuted)
            : videoElement.muted;
        videoElement.muted = true;

        // Keep aecPlayer volume, software makeupGain, & explicit mute state synchronized with videoElement changes (including ducking & volume button on iOS/iPadOS)
        const volumeSync = () => {
            if (aecPlayer) {
                aecPlayer.volume = videoElement.volume;
                if (videoElement._userExplicitlyMuted !== undefined) {
                    aecPlayer.muted = Boolean(videoElement._userExplicitlyMuted);
                }
            }
            if (makeupGain && makeupGain.gain) {
                const effVol = videoElement._userExplicitlyMuted ? 0 : (typeof videoElement.volume === 'number' ? videoElement.volume : 1.0);
                makeupGain.gain.value = 1.35 * effVol;
            }
        };
        videoElement.addEventListener('volumechange', volumeSync);

        aecPlayer.play().catch(e => console.warn("[Audio] Dialogue compressor play deferred:", e));

        const destroy = () => {
            if (videoElement._dialogueCompressorDestroy === destroy) {
                delete videoElement._dialogueCompressorDestroy;
            }
            videoElement.removeEventListener('volumechange', volumeSync);
            videoElement.muted = videoElement._userExplicitlyMuted !== undefined
                ? Boolean(videoElement._userExplicitlyMuted)
                : restoreMuted;

            if (aecPlayer) {
                aecPlayer.pause();
                aecPlayer.srcObject = null;
                if (aecPlayer.parentNode) aecPlayer.parentNode.removeChild(aecPlayer);
            }
            if (audioCtx) {
                audioCtx.close().catch(() => { });
            }
        };

        videoElement._dialogueCompressorDestroy = destroy;

        return {
            audioCtx,
            compressor,
            aecPlayer,
            setRestoreMuted: (muted) => { restoreMuted = Boolean(muted); },
            destroy
        };
    } catch (err) {
        console.warn("[Audio] Dialogue compressor setup failed:", err);
        return null;
    }
}

/**
 * Lightweight, opt-in local audio diagnostics helper.
 * Inspects transceiver mappings, audio track states, negotiated codecs, and RTP stats.
 * 
 * @param {RTCPeerConnection} peerConnection 
 * @param {object|null} [previousStats=null] - Prior diagnostic snapshot for bitrate delta calculation.
 * @returns {Promise<object>} Diagnostic snapshot.
 */
export async function getAudioDiagnostics(peerConnection, previousStats = null) {
    const report = {
        timestamp: Date.now(),
        connectionState: peerConnection ? peerConnection.connectionState : 'none',
        iceState: peerConnection ? peerConnection.iceConnectionState : 'none',
        tracks: [],
        transceivers: [],
        codecs: [],
        stats: {
            outbound: null,
            inbound: null
        },
        measuredBitrateKbps: null
    };

    if (!peerConnection) return report;

    // 1. Inspect Transceivers & Tracks
    try {
        const transceivers = peerConnection.getTransceivers ? peerConnection.getTransceivers() : [];
        transceivers.forEach(t => {
            const senderTrack = t.sender ? t.sender.track : null;
            const receiverTrack = t.receiver ? t.receiver.track : null;

            if ((senderTrack && senderTrack.kind === 'audio') || (receiverTrack && receiverTrack.kind === 'audio')) {
                report.transceivers.push({
                    mid: t.mid,
                    direction: t.direction,
                    currentDirection: t.currentDirection,
                    hasSender: Boolean(t.sender),
                    hasReceiver: Boolean(t.receiver)
                });
            }

            [senderTrack, receiverTrack].forEach(track => {
                if (track && track.kind === 'audio') {
                    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
                    report.tracks.push({
                        id: track.id,
                        kind: track.kind,
                        label: track.label || 'audio',
                        enabled: track.enabled,
                        muted: track.muted,
                        readyState: track.readyState,
                        settings: {
                            echoCancellation: settings.echoCancellation,
                            noiseSuppression: settings.noiseSuppression,
                            autoGainControl: settings.autoGainControl,
                            channelCount: settings.channelCount,
                            sampleRate: settings.sampleRate
                        }
                    });
                }
            });
        });
    } catch (e) {
        console.warn("[Diagnostics] Transceiver inspection warning:", e);
    }

    // 2. Inspect WebRTC Stats (RTP counters, codecs, bitrate deltas)
    try {
        if (typeof peerConnection.getStats === 'function') {
            const stats = await peerConnection.getStats();
            stats.forEach(reportItem => {
                if (reportItem.type === 'codec' && reportItem.mimeType && reportItem.mimeType.toLowerCase().includes('audio')) {
                    report.codecs.push({
                        id: reportItem.id,
                        mimeType: reportItem.mimeType,
                        clockRate: reportItem.clockRate,
                        channels: reportItem.channels,
                        sdpFmtpLine: reportItem.sdpFmtpLine
                    });
                } else if (reportItem.type === 'outbound-rtp' && (reportItem.kind === 'audio' || reportItem.mediaType === 'audio')) {
                    report.stats.outbound = {
                        bytesSent: reportItem.bytesSent,
                        packetsSent: reportItem.packetsSent,
                        timestamp: reportItem.timestamp
                    };
                } else if (reportItem.type === 'inbound-rtp' && (reportItem.kind === 'audio' || reportItem.mediaType === 'audio')) {
                    report.stats.inbound = {
                        bytesReceived: reportItem.bytesReceived,
                        packetsReceived: reportItem.packetsReceived,
                        packetsLost: reportItem.packetsLost,
                        jitter: reportItem.jitter,
                        timestamp: reportItem.timestamp
                    };
                }
            });

            // Calculate estimated bitrate delta if prior measurement exists
            if (previousStats && previousStats.stats) {
                if (report.stats.inbound && previousStats.stats.inbound) {
                    const deltaBytes = report.stats.inbound.bytesReceived - previousStats.stats.inbound.bytesReceived;
                    const deltaTimeSec = (report.stats.inbound.timestamp - previousStats.stats.inbound.timestamp) / 1000;
                    if (deltaTimeSec > 0 && deltaBytes >= 0) {
                        report.measuredBitrateKbps = Math.round((deltaBytes * 8) / (deltaTimeSec * 1000));
                    }
                } else if (report.stats.outbound && previousStats.stats.outbound) {
                    const deltaBytes = report.stats.outbound.bytesSent - previousStats.stats.outbound.bytesSent;
                    const deltaTimeSec = (report.stats.outbound.timestamp - previousStats.stats.outbound.timestamp) / 1000;
                    if (deltaTimeSec > 0 && deltaBytes >= 0) {
                        report.measuredBitrateKbps = Math.round((deltaBytes * 8) / (deltaTimeSec * 1000));
                    }
                }
            }
        }
    } catch (e) {
        console.warn("[Diagnostics] Stats collection warning:", e);
    }

    return report;
}
