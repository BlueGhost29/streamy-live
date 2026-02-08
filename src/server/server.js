const app = require("./app");
const http = require("http").createServer(app);
const io = require("socket.io")(http);
const socketHandler = require("./socket");

// Initialize Socket Logic
socketHandler(io);

const PORT = process.env.PORT || 4000;

http.listen(PORT, () => {
    console.log(`Streamy Pro running on http://localhost:${PORT}`);
});