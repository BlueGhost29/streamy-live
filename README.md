# 🎬 Streamy Pro

> An intimate, high-fidelity WebRTC watch party and screen-sharing experience with fine-arts theater aesthetics.

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![Express](https://img.shields.io/badge/Express-5.2-blue.svg)](https://expressjs.com/)
[![Socket.io](https://img.shields.io/badge/Socket.io-4.8-black.svg)](https://socket.io/)
[![WebRTC](https://img.shields.io/badge/WebRTC-P2P%20%2B%20TURN-orange.svg)](https://webrtc.org/)

---

## ✨ Features

- **Segregated Multi-Track Audio Engine**:
  - **Movie Audio**: Uncompressed stereo track bypasses browser echo cancellation to preserve soundtrack audio fidelity.
  - **Voice Intercom**: Isolated mono channel with native Echo Cancellation (AEC), Noise Suppression, and Auto Gain Control.
  - **Audio Ducking**: Automatically attenuates movie volume when friends speak.
- **Universal Cross-Platform Video**:
  - Waterfall screen-capture logic (Strict 1080p60 ➔ Generic Display ➔ Pure Video ➔ Camera fallback).
  - Hardware-accelerated VP9 codec prioritization for 4K/HD streaming.
  - Dynamic bitrate toggling (HD 4Mbps / SD 800kbps) requested per viewer.
- **Cinematic Theater Ambience**:
  - **Ambilight Projection**: Real-time canvas backdrop that projects the average edge colors of the stream into a soft surrounding glow.
  - **Laser Pointer**: Real-time canvas overlay to point out scenes to friends.
  - **Synchronized Countdown**: Theater-wide sync overlay (3-2-1 play) for simultaneous viewing.
  - **VIP Ticket Generator**: Off-screen HTML5 canvas that generates downloadable, personalized vintage theater passes.
- **Low-Latency Relay Resilience**:
  - Multi-path ICE candidate pool: Google STUN for direct P2P, fast UDP TURN (port 3478), and stealth TCP TURN (port 443) to bypass strict campus/firewall restrictions.
- **Ephemeral Bounded Chat**:
  - In-memory 50-message sliding window history with automatic garbage collection on room empty.

---

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) `>= 20.0.0`
- Modern web browser (Chrome, Edge, Firefox, Safari)

### Installation
```bash
# 1. Clone repository
git clone https://github.com/BlueGhost29/streamy-live.git
cd streamy-live

# 2. Install dependencies
npm install

# 3. Start the application
npm start
```

For development with hot-reloading (Node 20+ native watcher):
```bash
npm run dev
```

Visit **`http://localhost:4000`** in your browser.

---

## 🛠️ Project Structure

```text
Streamy/
├── AGENTS.md                  # Operating contract and safety rules for AI agents
├── GEMINI.md                  # Comprehensive developer specification & invariants
├── README.md                  # Documentation and quick start guide
├── package.json               # Dependencies and scripts
├── .env.example               # Environment variable template
└── src/
    ├── server/
    │   ├── server.js          # HTTP server & Socket.io entry point
    │   ├── app.js             # Express 5 static file & SPA routing
    │   └── socket.js          # WebRTC signaling, chat history & overlay events
    └── public/
        ├── index.html         # Theater lobby & ticket generator
        ├── room.html          # Cinematic theater viewing room
        ├── css/style.css      # Glassmorphism & custom theater styling
        └── js/
            ├── broadcaster.js # Screen capture, transceivers & AEC audio player
            ├── viewer.js      # Viewer peer connection & bitrate control
            └── ui.js          # Fullscreen cross-platform helpers
```

---

## 🧪 Verification & Health Checks

Run syntax validation on all backend scripts:
```bash
npm run check
```

---

## 🔒 Security & Privacy

- All video and audio streams travel directly peer-to-peer or encrypted over DTLS-SRTP relay.
- No stream media passes through or is recorded on disk.
- Chat history exists purely in transient RAM, bounded to 50 messages, and is scrubbed 15 seconds after all participants disconnect.

---

## 📄 License

MIT © [BlueGhost29](https://github.com/BlueGhost29)
