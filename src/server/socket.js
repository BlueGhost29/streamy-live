module.exports = (io) => {
    io.on("connection", (socket) => {
        
        // 1. Join a specific Room
        socket.on("join-room", (roomId, role) => {
            socket.join(roomId);
            console.log(`User ${socket.id} joined room: ${roomId} as ${role}`);
            
            if (role === 'viewer') {
                socket.to(roomId).emit("watcher", socket.id);
            }
        });

        // 2. Broadcaster identifies themselves
        socket.on("broadcaster", (roomId) => {
            socket.broadcast.to(roomId).emit("broadcaster");
        });

        // 3. Late Viewer / Reconnect Request
        socket.on("watcher", () => {
            const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
            if (roomId) {
                socket.to(roomId).emit("watcher", socket.id);
            }
        });

        // 4. WebRTC Signaling
        socket.on("offer", (id, message) => {
            socket.to(id).emit("offer", socket.id, message);
        });

        socket.on("answer", (id, message) => {
            socket.to(id).emit("answer", socket.id, message);
        });

        socket.on("candidate", (id, message) => {
            socket.to(id).emit("candidate", socket.id, message);
        });

        socket.on("disconnecting", () => {
            const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
            if (roomId) {
                socket.to(roomId).emit("disconnectPeer", socket.id);
            }
        });

        // ===================================
        // 5. Chat Feature
        // ===================================
        socket.on("chat-message", (roomId, payload) => {
            io.to(roomId).emit("chat-message", payload);
        });

        // ===================================
        // 6. Emoji Reactions
        // ===================================
        socket.on("reaction", (roomId, emoji) => {
            io.to(roomId).emit("reaction", emoji);
        });

        // ===================================
        // 7. NEW: Bitrate/Quality Toggle
        // ===================================
        socket.on("bitrate_request", (roomId, quality) => {
            // Viewer (socket.id) wants 'high' or 'low'
            // We tell the Broadcaster (everyone else in room) about this request
            socket.to(roomId).emit("bitrate_request", socket.id, quality);
        });
    });
};