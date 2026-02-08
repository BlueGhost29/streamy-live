module.exports = (io) => {
    io.on("connection", (socket) => {
        
        // 1. Join a specific Room
        socket.on("join-room", (roomId, role) => {
            socket.join(roomId);
            console.log(`User ${socket.id} joined room: ${roomId} as ${role}`);
            
            // Trigger handshake: Tell broadcaster a new viewer is here
            if (role === 'viewer') {
                socket.to(roomId).emit("watcher", socket.id);
            }
        });

        // 2. Broadcaster identifies themselves
        socket.on("broadcaster", (roomId) => {
            socket.broadcast.to(roomId).emit("broadcaster");
        });

        // 3. Late Viewer / Reconnect Request
        // If a viewer reloads, they ask "Is anyone broadcasting?"
        socket.on("watcher", () => {
            // We broadcast to the room the socket is currently in
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

        // 5. Handle Disconnect
        // Use 'disconnecting' to access rooms before the socket leaves
        socket.on("disconnecting", () => {
            const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
            if (roomId) {
                socket.to(roomId).emit("disconnectPeer", socket.id);
            }
        });
    });
};