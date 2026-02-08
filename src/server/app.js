const express = require("express");
const path = require("path");
const app = express();

// 1. Serve Static Files
// Points to 'src/public' (stepping back one level from 'src/server')
app.use(express.static(path.join(__dirname, "../public")));

// 2. Fallback Route (SPA Behavior)
// [FIXED] Express 5 requires a Regex (/.*/) instead of '*' to match all routes.
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

module.exports = app;