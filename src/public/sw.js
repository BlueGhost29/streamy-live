// src/public/sw.js
// Streamy Pro — Progressive Web App Service Worker
// Provides PWA installability across Windows (Chrome/Edge), Android (Chrome), and iPadOS/iOS
// while using a strict network-first strategy so live signaling and assets are never stale.

const CACHE_NAME = 'streamy-pro-v1';

self.addEventListener('install', () => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    // Never intercept Socket.IO polling/websocket, health checks, or cross-origin requests
    if (url.origin !== self.location.origin || url.pathname.startsWith('/socket.io/') || url.pathname === '/health') {
        return;
    }

    event.respondWith(
        fetch(req).catch(() => caches.match(req))
    );
});

