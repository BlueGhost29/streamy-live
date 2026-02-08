// ==========================================
// UI HELPER: Cross-Platform Fullscreen Logic
// ==========================================

export function toggleFullScreen(wrapper) {
    // 1. Check if we are currently in fullscreen
    const isFullscreen = document.fullscreenElement || document.webkitFullscreenElement;

    if (!isFullscreen) {
        // --- ENTER FULLSCREEN ---
        
        // A. Standard Fullscreen (Android, Windows, Mac Chrome, Desktop)
        // We try to make the *Wrapper* fullscreen so custom controls stay visible.
        if (wrapper.requestFullscreen) {
            wrapper.requestFullscreen().catch(err => {
                console.warn("Standard fullscreen denied, trying fallback...", err);
                tryVideoFallback(wrapper);
            });
        } 
        else if (wrapper.webkitRequestFullscreen) {
            wrapper.webkitRequestFullscreen();
        } 
        // B. iOS / iPad Fallback (The Critical Fix)
        // iOS Safari does NOT support 'requestFullscreen' on divs.
        // We must find the <video> tag and use 'webkitEnterFullscreen'.
        else {
            tryVideoFallback(wrapper);
        }
    } else {
        // --- EXIT FULLSCREEN ---
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
}

// Helper for iOS/iPad
function tryVideoFallback(wrapper) {
    const video = wrapper.querySelector('video');
    if (video) {
        if (video.webkitEnterFullscreen) {
            // iPad/iPhone specific command
            video.webkitEnterFullscreen(); 
        } else if (video.requestFullscreen) {
            // Some older Androids prefer direct video fullscreen
            video.requestFullscreen();
        }
    }
}

export function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}