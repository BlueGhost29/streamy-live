// Handles Fullscreen logic for different browsers (iPad vs PC)
export function toggleFullScreen(element) {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        if (element.requestFullscreen) {
            element.requestFullscreen();
        } else if (element.webkitEnterFullscreen) {
            // iOS Safari video specific
            element.webkitEnterFullscreen();
        } else if (element.webkitRequestFullscreen) {
            // Older Safari
            element.webkitRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
}

// Generates a random Room ID
export function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}