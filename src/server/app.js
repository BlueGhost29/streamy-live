const express = require("express");
const path = require("path");
const app = express();

// Serve static files from the 'src/public' folder
// Note: We go up one level (..) to get out of 'server' and into 'public'
app.use(express.static(path.join(__dirname, "../public")));

module.exports = app;