module.exports = (io) => {
    io.on("connection", (socket) => {
        
        // 1. Join a specific Room
        socket.on("join-room", (roomId, role) => {
            socket.join(roomId);
            console.log(`User ${socket.id} joined room: ${roomId} as ${role}`);
            
            // If a viewer joins, notify the broadcaster in THIS room only
            if (role === 'viewer') {
                socket.to(roomId).emit("watcher", socket.id);
            }
        });

        // 2. Broadcaster identifies themselves
        socket.on("broadcaster", (roomId) => {
            socket.broadcast.to(roomId).emit("broadcaster");
        });

        // 3. WebRTC Signaling (Restricted to the specific Room)
        socket.on("offer", (id, message) => {
            socket.to(id).emit("offer", socket.id, message);
        });

        socket.on("answer", (id, message) => {
            socket.to(id).emit("answer", socket.id, message);
        });

        socket.on("candidate", (id, message) => {
            socket.to(id).emit("candidate", socket.id, message);
        });

        // 4. Handle Disconnect
        socket.on("disconnect", () => {
            socket.to(Array.from(socket.rooms)[1]).emit("disconnectPeer", socket.id);
        });
    });
};