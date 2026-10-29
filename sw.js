// Offline cache: app files first from cache, refreshed in the background
const CACHE = "pillcount-v9";
const SHELL = ["./", "index.html", "counter.js", "ai.js", "model.onnx", "manifest.webmanifest", "icon-192.png", "icon-512.png",
  "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r && (r.ok || r.type === "opaque")) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
