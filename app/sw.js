// Offline support and reminder notifications (a module service worker).
//
// Offline: network first, so a new version shows up as soon as it's online; the cached copy is
// used when there's no connection. Also caches the sign-in/sync code shared from InkNotes.
//
// Reminders: the reminder service pushes { id, at, sealed }. The title is sealed with the sync
// passphrase key, which this worker reads from InkNotes' storage (same website). Complete marks
// the task done right here (repeating tasks open InkTasks, which makes the next copy); Snooze
// moves the reminder and tells the service.
import { store } from "/inknotes/js/store.js";
import { unsealJSON, fromB64 } from "/inknotes/js/crypt.js";
import { db } from "./js/db.js";
import { SNOOZE_MINUTES } from "./js/reminders-core.js";
import { completeFromNotification, snooze } from "./js/reminder-actions.js";

const CACHE = "inktasks-v2";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/app.js", "js/db.js", "js/model.js", "js/import.js", "js/config.js", "js/reminders.js", "js/reminders-core.js", "js/reminder-actions.js",
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

// ---------- reminders ----------
const ACTIONS = [{ action: "complete", title: "Complete" }, { action: "snooze", title: `Snooze ${SNOOZE_MINUTES} min` }];

async function titleOf(msg) {
  try {
    const key = await store.getMeta("key");
    if (key && msg.sealed) return (await unsealJSON(key, fromB64(msg.sealed), "reminder/" + msg.id)).title;
  } catch (err) { console.warn("Couldn't read the reminder", err); }
  try { const t = await db.get(msg.id); if (t && t.title) return t.title; } catch (_) { /* no local copy */ }
  return "A task is due";
}

self.addEventListener("push", e => {
  let msg = null;
  try { msg = e.data && e.data.json(); } catch (_) { /* not ours */ }
  if (!msg || !msg.id) return;
  e.waitUntil(titleOf(msg).then(title => self.registration.showNotification(title, {
    body: "InkTasks reminder", tag: msg.id, renotify: true, requireInteraction: true,
    icon: "icons/icon-192.png", data: { id: msg.id, at: msg.at }, actions: ACTIONS,
  })));
});

async function openTask(id, action) {
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const win = wins.find(w => new URL(w.url).pathname.startsWith("/inktasks/"));
  if (win) {
    win.postMessage({ type: "open", id, do: action });
    return win.focus();
  }
  return self.clients.openWindow(`/inktasks/?task=${encodeURIComponent(id)}${action ? "&do=" + action : ""}`);
}

self.addEventListener("notificationclick", e => {
  const { id } = e.notification.data || {};
  e.notification.close();
  if (!id) return;
  if (e.action === "complete") e.waitUntil(completeFromNotification(id).then(r => r === "open" ? openTask(id, "complete") : r === "missing" ? openTask(id) : null));
  else if (e.action === "snooze") e.waitUntil(snooze(id));
  else e.waitUntil(openTask(id));
});
