// Handles Fullscreen logic for ALL platforms (Android, PC, iOS)
export function toggleFullScreen(wrapper) {
    // 1. Check if we are already in fullscreen
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        
        // A. Standard Fullscreen (Android, Windows, Mac Chrome)
        // This makes the whole DIV fullscreen, keeping your custom UI visible.
        if (wrapper.requestFullscreen) {
            wrapper.requestFullscreen().catch(err => {
                console.warn("Fullscreen request denied:", err);
            });
        } 
        // B. Older WebKit Browsers
        else if (wrapper.webkitRequestFullscreen) {
            wrapper.webkitRequestFullscreen();
        } 
        // C. iOS / iPad Fallback (The Critical Fix)
        // iOS does NOT support fullscreening a <div>. 
        // We must find the <video> tag inside and trigger its native player.
        else {
            const video = wrapper.querySelector('video');
            if (video && video.webkitEnterFullscreen) {
                video.webkitEnterFullscreen(); // Enters iOS Native Player
            }
        }
    } 
    // 2. Exit Fullscreen Logic
    else {
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