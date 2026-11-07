// src/public/js/modules/features/overlays.js

/**
 * Visual Overlays: Ambilight Glow & Interactive Laser Pointer
 * 
 * Features:
 * 1. Ambilight: Downsamples video borders (128x72) onto a hardware-blurred backdrop canvas
 *    at ~30fps (design target KPI: < 2% CPU overhead on modern systems). Includes low-power toggle and visibility pause.
 * 2. Laser: Real-time pointer overlay transmitting normalized coordinates [0.0, 1.0].
 *    Includes smooth exponential trail fade and 1.5s idle clear (prevents lingering alpha artifacts).
 */

/**
 * Initializes the dynamic Ambilight canvas rendering loop.
 * 
 * @param {HTMLVideoElement} video - The source video player element.
 * @param {HTMLCanvasElement} canvas - The backdrop ambilight canvas element.
 * @returns {object} Controller with toggle(enable: boolean) and destroy() methods.
 */
export function initAmbilight(video, canvas) {
    if (!video || !canvas) return { toggle: () => {}, destroy: () => {} };

    // Prevent duplicate running loops on the same canvas
    if (canvas._ambilightCleanup) {
        canvas._ambilightCleanup();
    }

    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    let isRunning = true;
    let isEnabled = true;
    let animId = null;
    let lastDrawTime = 0;
    const FRAME_INTERVAL = 33; // ~30 fps throttle for minimal CPU overhead

    // Downsampled canvas dimensions: CSS blur provides the smooth visual dispersion
    canvas.width = 128;
    canvas.height = 72;

    function drawFrame(now) {
        if (!isRunning) return;

        if (isEnabled && 
            document.visibilityState === 'visible' && 
            !video.paused && 
            !video.ended && 
            video.readyState >= 2) {
            
            if (now - lastDrawTime >= FRAME_INTERVAL) {
                lastDrawTime = now;
                try {
                    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                } catch (e) {
                    // Security/readiness safety fallback
                }
            }
        }

        animId = requestAnimationFrame(drawFrame);
    }

    animId = requestAnimationFrame(drawFrame);

    const onVisibilityChange = () => {
        if (document.visibilityState === 'hidden' && ctx) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const cleanup = () => {
        isRunning = false;
        if (animId) {
            cancelAnimationFrame(animId);
            animId = null;
        }
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        delete canvas._ambilightCleanup;
    };

    canvas._ambilightCleanup = cleanup;

    return {
        toggle: (enable) => {
            isEnabled = !!enable;
            if (!isEnabled && ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        },
        destroy: cleanup
    };
}

/**
 * Initializes the interactive Laser pointer canvas overlay.
 * 
 * @param {HTMLCanvasElement} canvas - The foreground laser canvas.
 * @param {object} socket - The shared Socket.IO instance.
 * @param {string} roomId - The current room identifier.
 * @returns {object} Controller with destroy() method.
 */
export function initLaser(canvas, socket, roomId) {
    if (!canvas || !socket) return { destroy: () => {} };

    // Prevent duplicate laser controllers
    if (canvas._laserCleanup) {
        canvas._laserCleanup();
    }

    const ctx = canvas.getContext('2d');
    let isDrawing = false;
    let lastLaserTime = 0;
    let lastEmitTime = 0;

    function resizeLaser() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }

    window.addEventListener('resize', resizeLaser);
    resizeLaser();

    function drawLaser(x, y) {
        ctx.font = "24px sans-serif";
        ctx.shadowBlur = 15;
        ctx.shadowColor = '#ff0055';
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("❤️", x, y);
    }

    // Exponential trail fade interval (30ms tick)
    const fadeInterval = setInterval(() => {
        if (Date.now() - lastLaserTime > 1500) {
            // Zeno's paradox prevention: Clear completely after 1.5s idle
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
            ctx.globalCompositeOperation = 'destination-out';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.15)';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.globalCompositeOperation = 'source-over';
        }
    }, 30);

    function emitLaser(e) {
        const rect = canvas.getBoundingClientRect();
        const clientX = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
        const clientY = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);

        const clampedX = Math.max(0, Math.min(1, (clientX - rect.left) / (rect.width || 1)));
        const clampedY = Math.max(0, Math.min(1, (clientY - rect.top) / (rect.height || 1)));

        lastLaserTime = Date.now();
        drawLaser(clampedX * canvas.width, clampedY * canvas.height);

        // Throttle emission to ~30ms to prevent socket saturation
        const now = Date.now();
        if (now - lastEmitTime >= 30) {
            lastEmitTime = now;
            socket.emit('laser', roomId, { x: clampedX, y: clampedY });
        }
    }

    const onPointerDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        isDrawing = true;
        canvas._downX = typeof e.clientX === 'number' ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
        canvas._downY = typeof e.clientY === 'number' ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
        canvas._hasDragged = false;
    };
    const onPointerMove = (e) => {
        if (!isDrawing) return;
        const clientX = typeof e.clientX === 'number' ? e.clientX : (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
        const clientY = typeof e.clientY === 'number' ? e.clientY : (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
        if (!canvas._hasDragged && Math.hypot(clientX - (canvas._downX || 0), clientY - (canvas._downY || 0)) > 4) {
            canvas._hasDragged = true;
            canvas.style.cursor = 'crosshair';
        }
        if (canvas._hasDragged) emitLaser(e);
    };
    const onPointerUp = () => { isDrawing = false; canvas._hasDragged = false; canvas.style.cursor = ''; };
    const onPointerLeave = () => { isDrawing = false; canvas._hasDragged = false; canvas.style.cursor = ''; };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('pointercancel', onPointerLeave);

    const onRemoteLaser = (data) => {
        if (!data || typeof data.x !== 'number' || typeof data.y !== 'number') return;
        // Validate normalized coordinate bounds
        if (data.x < 0 || data.x > 1 || data.y < 0 || data.y > 1) return;

        const actualX = data.x * canvas.width;
        const actualY = data.y * canvas.height;
        lastLaserTime = Date.now();
        drawLaser(actualX, actualY);
    };

    socket.on('laser', onRemoteLaser);

    const cleanup = () => {
        clearInterval(fadeInterval);
        window.removeEventListener('resize', resizeLaser);
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onPointerMove);
        canvas.removeEventListener('pointerup', onPointerUp);
        canvas.removeEventListener('pointerleave', onPointerLeave);
        canvas.removeEventListener('pointercancel', onPointerLeave);
        socket.off('laser', onRemoteLaser);
        if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
        delete canvas._laserCleanup;
    };

    canvas._laserCleanup = cleanup;

    return { destroy: cleanup };
}

