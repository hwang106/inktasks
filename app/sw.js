// Offline support. Network first, so a new version shows up as soon as it's online; the cached
// copy is used when there's no connection. Also caches the sign-in/sync code shared from InkNotes.
const CACHE = "inktasks-v1";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/app.js", "js/db.js", "js/model.js", "js/import.js",
  "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png",
  "/inknotes/js/sync.js", "/inknotes/js/sync-ui.js", "/inknotes/js/sync-engine.js", "/inknotes/js/auth.js",
  "/inknotes/js/graph.js", "/inknotes/js/crypt.js", "/inknotes/js/store.js", "/inknotes/js/config.js",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k.startsWith("inktasks-") && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const isFont = /fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (!sameOrigin && !isFont) return;
  e.respondWith(
    fetch(req)
      .then(res => {
        if (res.ok || res.type === "opaque") {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: sameOrigin && url.pathname.endsWith("/") }).then(r => r || caches.match("index.html")))
  );
});
