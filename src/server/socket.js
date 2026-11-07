// src/server/socket.js
const chatHistory = new Map(); // Map<roomId, Array<MsgObject>>
const cleanupTimers = new Map(); // Map<roomId, NodeJS.Timeout>
const roomHosts = new Map(); // Map<roomId, socketId>

const RESERVED_ROOM_IDS = new Set([
    "__proto__",
    "constructor",
    "prototype",
    "tostring",
    "valueof",
    "hasownproperty",
    "isprototypeof",
    "propertyisenumerable",
    "tolocalestring",
    "__definegetter__",
    "__definesetter__",
    "__lookupgetter__",
    "__lookupsetter__"
]);

// Strict room ID validator: alphanumeric, underscore, hyphen, bounded 1-64 chars, excluding reserved prototype properties
function isValidRoomId(roomId) {
    if (typeof roomId !== "string") return false;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) return false;
    if (RESERVED_ROOM_IDS.has(roomId.toLowerCase())) return false;
    return true;
}

module.exports = (io) => {

    // Helper to verify if two sockets share at least one named room
    function sharesCommonRoom(socketA, socketB) {
        if (!socketA || !socketB || !socketA.rooms || !socketB.rooms) return false;
        for (const r of socketA.rooms) {
            if (r !== socketA.id && socketB.rooms.has(r)) {
                return true;
            }
        }
        return false;
    }

    // Count connected sockets actively occupying a room (optionally excluding a socket that is currently leaving)
    function getActiveRoomSize(roomId, excludeSocketId = null) {
        const room = io.sockets.adapter.rooms.get(roomId);
        if (!room) return 0;
        let count = 0;
        for (const memberId of room) {
            if (memberId === excludeSocketId) continue;
            const memberSocket = io.sockets.sockets.get(memberId);
            if (memberSocket && memberSocket.connected) {
                count++;
            }
        }
        return count;
    }

    // Schedule 15-second debounced room state purge once a room has 0 active participants
    function scheduleRoomCleanup(roomId, delayMs = 15000) {
        if (!isValidRoomId(roomId)) return;
        if (cleanupTimers.has(roomId)) {
            clearTimeout(cleanupTimers.get(roomId));
            cleanupTimers.delete(roomId);
        }
        const timer = setTimeout(() => {
            if (getActiveRoomSize(roomId) === 0) {
                chatHistory.delete(roomId);
                roomHosts.delete(roomId);
                cleanupTimers.delete(roomId);
                console.log(`[Memory] Cleaned up stale room instance: ${roomId}`);
            } else {
                cleanupTimers.delete(roomId);
            }
        }, delayMs);
        if (typeof timer.unref === "function") {
            timer.unref();
        }
        cleanupTimers.set(roomId, timer);
    }

    // Handle a socket leaving a specific room (via explicit leave-room, room switch, or socket disconnect)
    function handleSocketLeaveRoom(socket, roomId, isDisconnecting = false) {
        if (!isValidRoomId(roomId)) return;

        socket.to(roomId).emit("disconnectPeer", socket.id);

        if (roomHosts.get(roomId) === socket.id) {
            roomHosts.delete(roomId);
            socket.to(roomId).emit("host-left", socket.id);
        }

        if (!isDisconnecting) {
            socket.leave(roomId);
        }

        const remaining = getActiveRoomSize(roomId, isDisconnecting ? socket.id : null);
        if (remaining === 0) {
            scheduleRoomCleanup(roomId, 15000);
        }
    }

    // Periodic safety sweep: ensure any room with 0 active sockets and no pending timer is scheduled for cleanup
    const staleSweepInterval = setInterval(() => {
        const trackedRooms = new Set([...chatHistory.keys(), ...roomHosts.keys()]);
        for (const roomId of trackedRooms) {
            const hostId = roomHosts.get(roomId);
            if (hostId) {
                const hostSocket = io.sockets.sockets.get(hostId);
                if (!hostSocket || !hostSocket.connected || !hostSocket.rooms.has(roomId)) {
                    roomHosts.delete(roomId);
                }
            }
            if (getActiveRoomSize(roomId) === 0 && !cleanupTimers.has(roomId)) {
                scheduleRoomCleanup(roomId, 15000);
            }
        }
    }, 30000);
    if (typeof staleSweepInterval.unref === "function") {
        staleSweepInterval.unref();
    }

    io.on("connection", (socket) => {
        
        // ===================================
        // 1. CONNECTION & ROOM LOGIC
        // ===================================
        socket.on("check-room", (roomId, callback) => {
            if (typeof callback !== "function") return;
            if (!isValidRoomId(roomId)) {
                callback(false);
                return;
            }
            const hostId = roomHosts.get(roomId);
            const hostSocket = hostId ? io.sockets.sockets.get(hostId) : null;
            const isHostActive = Boolean(hostSocket && hostSocket.connected && hostSocket.rooms.has(roomId));
            if (hostId && !isHostActive) {
                roomHosts.delete(roomId);
            }
            callback(isHostActive);
        });

        socket.on("join-room", (roomId, role, username) => {
            if (!isValidRoomId(roomId)) return;
            if (role !== "broadcaster" && role !== "viewer") return;

            const cleanUsername = typeof username === "string" ? username.slice(0, 50) : "Unknown";
            socket.data.username = cleanUsername;

            // If this socket was previously occupying another room, leave and clean up that previous room first
            for (const prevRoom of Array.from(socket.rooms)) {
                if (prevRoom !== socket.id && prevRoom !== roomId) {
                    handleSocketLeaveRoom(socket, prevRoom, false);
                }
            }

            // Cancel any pending cleanup timer for this room since a participant is active/rejoining
            if (cleanupTimers.has(roomId)) {
                clearTimeout(cleanupTimers.get(roomId));
                cleanupTimers.delete(roomId);
                console.log(`[Memory] Cancelled cleanup timer for room: ${roomId} due to active participant join`);
            }

            // Role assignment and single-host enforcement
            let assignedRole = role;
            if (role === "broadcaster") {
                const existingHostId = roomHosts.get(roomId);
                const existingHostSocket = existingHostId ? io.sockets.sockets.get(existingHostId) : null;
                if (existingHostSocket && existingHostSocket.connected && existingHostSocket.rooms.has(roomId) && existingHostId !== socket.id) {
                    // Another active broadcaster is already present in this room.
                    // Demote to viewer to protect single-host broadcast topology.
                    assignedRole = "viewer";
                    socket.emit("role-demoted", roomId);
                    console.warn(`User ${socket.id} attempted to claim host in room ${roomId} while host ${existingHostId} is active. Demoted to viewer.`);
                } else {
                    roomHosts.set(roomId, socket.id);
                }
            } else if (roomHosts.get(roomId) === socket.id) {
                // A host intentionally switched to viewer mode before capture.
                roomHosts.delete(roomId);
                socket.to(roomId).emit("host-left", socket.id);
            }

            socket.join(roomId);
            console.log(`User ${socket.id} joined room: ${roomId} as ${assignedRole} (${cleanUsername})`);
            
            // Send existing chat history to the NEW user only
            if (chatHistory.has(roomId) && chatHistory.get(roomId).length > 0) {
                socket.emit("chat-history", chatHistory.get(roomId));
            }

            // Notify others of participant arrival & inform joining viewer of active host ID
            if (assignedRole === 'viewer') {
                const activeHostId = roomHosts.get(roomId);
                if (activeHostId) {
                    const activeHostSocket = io.sockets.sockets.get(activeHostId);
                    if (activeHostSocket && activeHostSocket.connected && activeHostSocket.rooms.has(roomId)) {
                        socket.emit("host-present", activeHostId);
                    } else {
                        roomHosts.delete(roomId);
                    }
                }
                socket.to(roomId).emit("watcher", socket.id, cleanUsername);
            } else if (assignedRole === 'broadcaster') {
                socket.to(roomId).emit("host-joined", socket.id);
            }
        });

        socket.on("leave-room", (roomId) => {
            if (roomId && isValidRoomId(roomId) && socket.rooms.has(roomId)) {
                handleSocketLeaveRoom(socket, roomId, false);
            } else {
                for (const r of Array.from(socket.rooms)) {
                    if (r !== socket.id) {
                        handleSocketLeaveRoom(socket, r, false);
                    }
                }
            }
        });

        // 2. Broadcaster identifies themselves
        socket.on("broadcaster", (roomId) => {
            if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) return;
            // Only the designated host for this room can announce as broadcaster
            if (roomHosts.get(roomId) !== socket.id) return;
            socket.broadcast.to(roomId).emit("broadcaster");
        });

        socket.on("broadcast-stopped", (roomId) => {
            if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) return;
            if (roomHosts.get(roomId) !== socket.id) return;
            socket.to(roomId).emit("broadcast-stopped");
        });

        // 3. Late Viewer / Reconnect Request
        socket.on("watcher", (username) => {
            const roomId = Array.from(socket.rooms).find(r => r !== socket.id);
            if (roomId && isValidRoomId(roomId)) {
                const cleanUsername = (typeof username === "string" && username.trim() && username !== roomId)
                    ? username.slice(0, 50)
                    : (socket.data.username || undefined);
                socket.to(roomId).emit("watcher", socket.id, cleanUsername);
            }
        });

        let disconnectingRooms = [];
        socket.on("disconnecting", () => {
            disconnectingRooms = Array.from(socket.rooms).filter(r => r !== socket.id);
            for (const roomId of disconnectingRooms) {
                handleSocketLeaveRoom(socket, roomId, true);
            }
        });

        socket.on("disconnect", () => {
            for (const roomId of disconnectingRooms) {
                if (isValidRoomId(roomId) && getActiveRoomSize(roomId) === 0 && !cleanupTimers.has(roomId)) {
                    scheduleRoomCleanup(roomId, 15000);
                }
            }
            disconnectingRooms = [];
        });

        // ===================================
        // 4. WEBRTC SIGNALING (Strict Relay)
        // ===================================
        socket.on("offer", (id, message) => {
            if (typeof id !== "string" || !message || typeof message !== "object") return;
            const targetSocket = io.sockets.sockets.get(id);
            if (!targetSocket || !sharesCommonRoom(socket, targetSocket)) return;
            targetSocket.emit("offer", socket.id, message);
        });

        socket.on("answer", (id, message) => {
            if (typeof id !== "string" || !message || typeof message !== "object") return;
            const targetSocket = io.sockets.sockets.get(id);
            if (!targetSocket || !sharesCommonRoom(socket, targetSocket)) return;
            targetSocket.emit("answer", socket.id, message);
        });

        socket.on("candidate", (id, message) => {
            if (typeof id !== "string" || !message || typeof message !== "object") return;
            const targetSocket = io.sockets.sockets.get(id);
            if (!targetSocket || !sharesCommonRoom(socket, targetSocket)) return;
            targetSocket.emit("candidate", socket.id, message);
        });

        // ===================================
        // 5. CHAT FEATURE (With History)
        // ===================================
        socket.on("chat-message", (roomId, payload) => {
            if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) return;
            if (!payload || typeof payload !== "object") return;
            if (typeof payload.text !== "string" || !payload.text.trim()) return;

            const sanitizedPayload = {
                user: typeof payload.user === "string" ? payload.user.slice(0, 50) : "Anonymous",
                text: payload.text.slice(0, 500),
                time: typeof payload.time === "string" ? payload.time.slice(0, 30) : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
                senderId: socket.id
            };

            // Initialize room history if needed
            if (!chatHistory.has(roomId)) {
                chatHistory.set(roomId, []);
            }
            
            const history = chatHistory.get(roomId);
            history.push(sanitizedPayload);

            // Memory Management: Keep only last 50 messages
            if (history.length > 50) {
                history.shift(); // Remove oldest
            }

            // Broadcast to everyone in the room
            io.to(roomId).emit("chat-message", sanitizedPayload);
        });

        // ===================================
        // 6. EMOJI REACTIONS
        // ===================================
        socket.on("reaction", (roomId, emoji) => {
            if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) return;
            if (typeof emoji !== 'string' || !emoji || emoji.length > 8) return;
            io.to(roomId).emit("reaction", emoji);
        });

        // ===================================
        // 7. WEBRTC OVERLAYS (Sync & Laser)
        // ===================================
        socket.on("laser", (roomId, data) => {
            if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) return;
            if (!data || typeof data !== 'object') return;
            if (typeof data.x === 'number' && typeof data.y === 'number' &&
                data.x >= 0 && data.x <= 1 && data.y >= 0 && data.y <= 1) {
                const sanitized = { x: data.x, y: data.y };
                if (typeof data.color === 'string' && data.color.length <= 25) {
                    sanitized.color = data.color;
                }
                socket.to(roomId).emit("laser", sanitized);
            }
        });

        socket.on("sync-play", (roomId) => {
            if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) return;
            socket.to(roomId).emit("sync-play"); 
        });

        // ===================================
        // 8. BITRATE/QUALITY TOGGLE
        // ===================================
        socket.on("bitrate_request", (roomId, quality) => {
            if (!isValidRoomId(roomId) || !socket.rooms.has(roomId)) return;
            if (quality !== 'high' && quality !== 'low') {
                return;
            }
            // Viewer (socket.id) wants 'high' or 'low'
            // Tell the Broadcaster (everyone else in room) about this request
            socket.to(roomId).emit("bitrate_request", socket.id, quality);
        });
    });
};

module.exports.isValidRoomId = isValidRoomId;
module.exports.RESERVED_ROOM_IDS = RESERVED_ROOM_IDS;
