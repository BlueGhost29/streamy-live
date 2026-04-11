// ==========================================
// UI HELPER: Cross-Platform Fullscreen Logic
// ==========================================

export function toggleFullScreen(wrapper) {
    const isFullscreen = document.fullscreenElement || 
                         document.webkitFullscreenElement || 
                         document.msFullscreenElement;

    if (!isFullscreen) {
        if (wrapper.requestFullscreen) {
            wrapper.requestFullscreen().catch(err => {
                console.warn("Standard fullscreen denied, trying fallback...", err);
                tryVideoFallback(wrapper);
            });
        } else if (wrapper.webkitRequestFullscreen) {
            wrapper.webkitRequestFullscreen();
        } else if (wrapper.msRequestFullscreen) {
            wrapper.msRequestFullscreen();
        } else {
            tryVideoFallback(wrapper);
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    }
}

// Helper for iOS/iPad
function tryVideoFallback(wrapper) {
    const video = wrapper.querySelector('video');
    if (video) {
        if (video.webkitEnterFullscreen) {
            video.webkitEnterFullscreen(); 
        } else if (video.requestFullscreen) {
            video.requestFullscreen();
        } else if (video.webkitRequestFullscreen) {
            video.webkitRequestFullscreen();
        } else if (video.msRequestFullscreen) {
            video.msRequestFullscreen();
        }
    }
}

export function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}