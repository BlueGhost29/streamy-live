// src/server/socket.js
const chatHistory = {}; // Stores history: { "ROOM_ID": [Array of Msg Objects] }

module.exports = (io) => {
    io.on("connection", (socket) => {
        
        // ===================================
        // 1. CONNECTION & ROOM LOGIC
        // ===================================
        socket.on("check-room", (roomId, callback) => {
            const room = io.sockets.adapter.rooms.get(roomId);
            if (room && room.size > 0) {
                callback(true); // Host exists
            } else {
                callback(false); // Room empty
            }
        });

        socket.on("join-room", (roomId, role, username) => {
            socket.join(roomId);
            console.log(`User ${socket.id} joined room: ${roomId} as ${role} (${username || 'Unknown'})`);
            
            // [NEW] Send existing chat history to the NEW user only
            // This ensures they see what happened before they joined.
            if (chatHistory[roomId] && chatHistory[roomId].length > 0) {
                socket.emit("chat-history", chatHistory[roomId]);
            }

            // Notify others if a viewer joined
            if (role === 'viewer') {
                socket.to(roomId).emit("watcher", socket.id, username);
            }
        });

        // 2. Broadcaster identifies themselves
        socket.on("broadcaster", (roomId) => {
            socket.broadcast.to(roomId).emit("broadcaster");
        });

        // 3. Late Viewer / Reconnect Request
        socket.on("watcher", (username) => {
            const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
            if (roomId) {
                socket.to(roomId).emit("watcher", socket.id, username);
            }
        });

        socket.on("disconnecting", () => {
            const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
            if (roomId) {
                socket.to(roomId).emit("disconnectPeer", socket.id);
                
                // [FIX] Memory Management: Clean up chat history if room is empty
                const room = io.sockets.adapter.rooms.get(roomId);
                if (room && room.size <= 1) { 
                    // Give a 15-second grace period for page refreshes
                    setTimeout(() => {
                        const updatedRoom = io.sockets.adapter.rooms.get(roomId);
                        if (!updatedRoom || updatedRoom.size === 0) {
                            delete chatHistory[roomId];
                            console.log(`[Memory] Cleaned up chat history for empty room: ${roomId}`);
                        }
                    }, 15000); 
                }
            }
        });

        // ===================================
        // 4. WEBRTC SIGNALING (Strict Relay)
        // ===================================
        socket.on("offer", (id, message) => {
            socket.to(id).emit("offer", socket.id, message);
        });

        socket.on("answer", (id, message) => {
            socket.to(id).emit("answer", socket.id, message);
        });

        socket.on("candidate", (id, message) => {
            socket.to(id).emit("candidate", socket.id, message);
        });

        // ===================================
        // 5. CHAT FEATURE (With History)
        // ===================================
        socket.on("chat-message", (roomId, payload) => {
            if (!roomId || !payload) return; // Prevent crashes from malformed payloads

            // A. Initialize room history if needed
            if (!chatHistory[roomId]) {
                chatHistory[roomId] = [];
            }
            
            // B. Add new message to storage
            chatHistory[roomId].push(payload);

            // C. Memory Management: Keep only last 50 messages
            // This prevents the server RAM from filling up indefinitely.
            if (chatHistory[roomId].length > 50) {
                chatHistory[roomId].shift(); // Remove oldest
            }

            // D. Broadcast to everyone in the room
            io.to(roomId).emit("chat-message", payload);
        });

        // ===================================
        // 6. EMOJI REACTIONS
        // ===================================
        socket.on("reaction", (roomId, emoji) => {
            io.to(roomId).emit("reaction", emoji);
        });

        // ===================================
        // 7. WEBRTC OVERLAYS (Sync & Laser)
        // ===================================
        socket.on("laser", (roomId, data) => {
            socket.to(roomId).emit("laser", data);
        });

        socket.on("sync-play", (roomId) => {
            socket.to(roomId).emit("sync-play"); 
        });

        // ===================================
        // 7. BITRATE/QUALITY TOGGLE
        // ===================================
        socket.on("bitrate_request", (roomId, quality) => {
            // Viewer (socket.id) wants 'high' or 'low'
            // We tell the Broadcaster (everyone else in room) about this request
            socket.to(roomId).emit("bitrate_request", socket.id, quality);
        });
    });
};