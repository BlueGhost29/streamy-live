// src/public/js/ui.js

/**
 * UI HELPER: Cross-Platform Fullscreen & Theater Viewport Engine
 * 
 * Implements:
 * 1. Native standard OS Fullscreen API for supporting desktop and Android Chromium browsers.
 * 2. Progressive Viewport-Filling Theater Mode for iPadOS/iOS Safari where native requestFullscreen
 *    is restricted or absent, keeping chat, ambilight, reactions, and laser overlays accessible
 *    without detaching into the isolated native iOS media player.
 * 3. 6-Character alphanumeric room code generator.
 */

/**
 * Toggles fullscreen across platforms using standard Fullscreen API with
 * seamless fallback to Viewport-Filling Theater Mode.
 * 
 * @param {HTMLElement} [wrapper=document.documentElement] - Element to target for fullscreen.
 * @returns {boolean} True if fullscreen/theater mode is now active, false if exited.
 */
export function toggleFullScreen(wrapper = document.documentElement) {
    const isNativeFullscreen = Boolean(
        document.fullscreenElement || 
        document.webkitFullscreenElement || 
        document.msFullscreenElement
    );
    const isTheaterFullscreen = document.body.classList.contains('theater-fullscreen');

    // If either native fullscreen or theater viewport mode is active, exit
    if (isNativeFullscreen || isTheaterFullscreen) {
        if (isTheaterFullscreen) {
            document.body.classList.remove('theater-fullscreen');
        }
        if (isNativeFullscreen) {
            if (document.exitFullscreen) {
                document.exitFullscreen().catch(() => {});
            } else if (document.webkitExitFullscreen) {
                document.webkitExitFullscreen();
            } else if (document.msExitFullscreen) {
                document.msExitFullscreen();
            }
        }
        return false;
    }

    // Attempt Native Standard Fullscreen first
    const target = wrapper || document.documentElement;
    const verifyOrFallbackToTheater = () => {
        setTimeout(() => {
            const activeNative = Boolean(
                document.fullscreenElement ||
                document.webkitFullscreenElement ||
                document.msFullscreenElement
            );
            if (!activeNative && !document.body.classList.contains('theater-fullscreen')) {
                enableTheaterViewportMode();
            }
        }, 150);
    };

    if (target.requestFullscreen && typeof target.requestFullscreen === 'function') {
        try {
            const res = target.requestFullscreen();
            if (res && typeof res.catch === 'function') {
                res.catch(err => {
                    console.warn("[UI] Standard requestFullscreen rejected. Falling back to Theater Viewport mode.", err);
                    enableTheaterViewportMode();
                });
            }
            verifyOrFallbackToTheater();
        } catch (err) {
            enableTheaterViewportMode();
        }
        return true;
    } else if (target.webkitRequestFullscreen && typeof target.webkitRequestFullscreen === 'function') {
        try {
            const res = target.webkitRequestFullscreen();
            if (res && typeof res.catch === 'function') {
                res.catch(() => enableTheaterViewportMode());
            }
            verifyOrFallbackToTheater();
            return true;
        } catch (err) {
            console.warn("[UI] webkitRequestFullscreen failed. Falling back to Theater Viewport mode.", err);
            enableTheaterViewportMode();
            return true;
        }
    } else {
        // Fallback for iPadOS / iOS Safari & Chrome (CriOS): Viewport-Filling Theater Mode
        enableTheaterViewportMode();
        return true;
    }
}

/**
 * Engages the non-detached Viewport-Filling Theater Mode.
 * Expands UI to fill 100vw x 100dvh while preserving chat, reactions, and canvas overlays.
 */
export function enableTheaterViewportMode() {
    document.body.classList.add('theater-fullscreen');
    console.log("[UI] Theater Viewport Mode engaged (preserving cinema overlays).");
}

/**
 * Disengages Theater Viewport Mode.
 */
export function disableTheaterViewportMode() {
    document.body.classList.remove('theater-fullscreen');
    console.log("[UI] Theater Viewport Mode disengaged.");
}

/**
 * Returns whether Theater Viewport Mode is currently engaged.
 * @returns {boolean}
 */
export function isTheaterViewportActive() {
    return document.body.classList.contains('theater-fullscreen');
}

/**
 * Generates an uppercase 6-character room code.
 * @returns {string}
 */
export function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}