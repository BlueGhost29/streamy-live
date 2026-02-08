const express = require("express");
const path = require("path");
const app = express();

// Change "public" to "../public"
app.use(express.static(path.join(__dirname, "../public")));

// Change the fallback route too:
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public', 'index.html'));
});

module.exports = app;