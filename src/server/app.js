const express = require("express");
const path = require("path");
const app = express();

// 1. Health Check Endpoint (Used by Render health checks & client keep-alive pings during active streams)
app.get("/health", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.status(200).json({ status: "ok", uptime: Math.round(process.uptime()) });
});

// 2. Serve Static Files (with no-cache on PWA Service Worker & Manifest)
app.use(express.static(path.join(__dirname, "../public"), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith("sw.js")) {
            res.set("Cache-Control", "no-cache, no-store, must-revalidate");
            res.set("Service-Worker-Allowed", "/");
        } else if (filePath.endsWith("manifest.json")) {
            res.set("Cache-Control", "no-cache");
        }
    }
}));

// 3. Fallback Route (SPA Behavior)
// [FIXED] Express 5 requires a Regex (/.*/) instead of '*' to match all routes.
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

module.exports = app;