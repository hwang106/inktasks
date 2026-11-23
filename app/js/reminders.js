// Reminders. Tells the reminder service (worker/) when each task's reminder is due, so it can
// push a notification to every device even when InkTasks is closed. The service gets only the id,
// the time and the title sealed with the sync passphrase key, which it can't read.
//
// What the service already has is remembered per browser (InkNotes' meta store: "reminders:sent"),
// so only changes are sent and a failed send is simply retried next time. This browser's
// registration with the service is "reminders:device" { device, token, push: endpoint | null }.
// The service worker (sw.js) reads both, to snooze from a notification.
//
// Without the service, push permission or OneDrive sync, reminders still show while InkTasks is
// open on this device.
import { store } from "/inknotes/js/store.js";
import { accessToken } from "/inknotes/js/auth.js";
import { REMINDER_SERVICE, VAPID_PUBLIC } from "./config.js";
import { SNOOZE_MINUTES, remindAt, sealReminder } from "./reminders-core.js";
export { remindAt };

const LOCAL_WINDOW = 24 * 3600e3;
const GRACE = 60e3;   // a reminder set a moment ago in the past still fires

const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in self && "Notification" in self;
export const permission = () => ("Notification" in self ? Notification.permission : "unsupported");

export async function askPermission() {
  if (!("Notification" in self)) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  try { return await Notification.requestPermission(); } catch (_) { return Notification.permission; }
}

async function subscription() {
  if (!REMINDER_SERVICE || !VAPID_PUBLIC || !pushSupported() || Notification.permission !== "granted") return null;
  const reg = await navigator.serviceWorker.ready;
  const want = unb64u(VAPID_PUBLIC);
  let sub = await reg.pushManager.getSubscription();
  const has = sub && sub.options && sub.options.applicationServerKey && new Uint8Array(sub.options.applicationServerKey);
  if (sub && has && (has.length !== want.length || has.some((b, i) => b !== want[i]))) {
    await sub.unsubscribe(); sub = null;   // made for an older service key
  }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: want });
}

async function post(path, body, dev) {
  const res = await fetch(REMINDER_SERVICE.replace(/\/$/, "") + path, {
    method: "POST", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...(dev ? { Authorization: `Device ${dev.device}:${dev.token}` } : {}) },
  });
  if (!res.ok) { const e = new Error((await res.json().catch(() => ({}))).error || "Reminder service error " + res.status); e.status = res.status; throw e; }
  return res.json();
}

// This browser's registration, made or refreshed when push permission or the push address changed.
async function device(state) {
  let dev = await store.getMeta("reminders:device");
  let sub = null;
  try { sub = await subscription(); } catch (err) { console.warn("Push subscription failed", err); }
  const endpoint = sub ? sub.endpoint : null;
  if (dev && dev.push === endpoint) { state.push = !!endpoint; return dev; }
  let msToken;
  try { msToken = await accessToken(); } catch (err) {
    state.signedOut = !!(err.signedOut || err.reauth);
    state.push = !!(dev && dev.push);
    return dev || null;
  }
  state.signedOut = false;
  try {
    const r = await post("/register", { subscription: sub ? sub.toJSON() : null, msToken, previous: dev ? { device: dev.device, token: dev.token } : undefined });
    dev = { device: r.device, token: r.token, push: endpoint };
    await store.setMeta("reminders:device", dev);
    if (!(await store.getMeta("reminders:sent"))) await store.setMeta("reminders:sent", {});
    state.push = !!endpoint; state.otherAccount = false;
    return dev;
  } catch (err) {
    state.error = err.message;
    state.otherAccount = err.status === 403;
    state.push = !!(dev && dev.push);
    return dev || null;
  }
}

export function createReminders({ all, remindHere = () => {}, onChange = () => {} }) {
  const state = { push: false, signedOut: false, noKey: false, error: "", otherAccount: false };
  let timer = null, running = null, again = false;
  const localTimers = new Map();

  async function showLocal(t) {
    const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && permission() === "granted") {
      reg.showNotification(t.title || "Untitled task", {
        body: "InkTasks reminder", tag: t.id, data: { id: t.id, at: remindAt(t) }, icon: "icons/icon-192.png", requireInteraction: true,
        actions: [{ action: "complete", title: "Complete" }, { action: "snooze", title: `Snooze ${SNOOZE_MINUTES} min` }],
      });
    } else remindHere(t);
  }
  // While InkTasks is open on a device the service can't notify, it keeps its own timers.
  function armLocal(tasks) {
    for (const h of localTimers.values()) clearTimeout(h);
    localTimers.clear();
    if (state.push) return;
    const now = Date.now();
    for (const t of tasks) {
      const at = remindAt(t);
      if (at && at > now - GRACE && at < now + LOCAL_WINDOW) {
        localTimers.set(t.id, setTimeout(() => {
          const cur = all().find(x => x.id === t.id);
          if (remindAt(cur) === at) showLocal(cur);
        }, Math.max(0, at - now)));
      }
    }
  }

  async function run() {
    const tasks = all();
    if (!REMINDER_SERVICE) { state.push = false; armLocal(tasks); return; }
    const key = await store.getMeta("key");
    state.noKey = !key;
    if (!key) { state.push = false; armLocal(tasks); return; }
    const dev = await device(state);
    armLocal(tasks);
    if (!dev) return;
    const sent = (await store.getMeta("reminders:sent")) || {};
    const now = Date.now(), changes = [];
    for (const t of tasks) {
      let at = remindAt(t);
      const had = sent[t.id];
      if (at && at < now - GRACE && (!had || had.at !== at)) at = null;   // long past (imported, say): don't fire now
      if (!had && !at) continue;
      if (had && had.at === at && (!at || had.title === t.title)) continue;
      changes.push({ t, at });
    }
    for (let i = 0; i < changes.length; i += 200) {
      const chunk = changes.slice(i, i + 200);
      const items = await Promise.all(chunk.map(async ({ t, at }) => ({
        id: t.id, at, updated: t.updated || 0, payload: at ? await sealReminder(key, t) : undefined,
      })));
      try {
        await post("/reminders", { items }, dev);
      } catch (err) {
        if (err.status === 401) { await store.deleteMeta("reminders:device"); await store.setMeta("reminders:sent", {}); again = true; }   // the service forgot this device
        else state.error = err.message;
        return;
      }
      for (const { t, at } of chunk) sent[t.id] = { at, title: t.title };
      await store.setMeta("reminders:sent", sent);
    }
    state.error = "";
  }

  function now() {
    if (running) { again = true; return running; }
    const go = () => (navigator.locks ? navigator.locks.request("inktasks-reminders", run) : run());
    running = go().catch(err => { state.error = err.message; console.warn("Reminders:", err); })
      .finally(() => { running = null; onChange(); if (again) { again = false; soon(); } });
    return running;
  }
  function soon(ms = 1500) { clearTimeout(timer); timer = setTimeout(now, ms); }

  addEventListener("online", () => soon(0));
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") soon(500); });

  // One line for the detail pane: "" when reminders will reach every device, "ask" when the
  // browser hasn't been asked about notifications yet.
  function hint() {
    const p = permission();
    if (p === "unsupported") return "This browser can't show notifications. Reminders appear here while InkTasks is open.";
    if (p === "denied") return "Notifications are blocked for this site. Allow them in the browser's site settings.";
    if (p === "default") return "ask";
    if (!REMINDER_SERVICE) return "Reminders show while InkTasks is open on this device.";
    if (state.otherAccount) return "The reminder service belongs to a different Microsoft account.";
    if (state.noKey || state.signedOut) return "Turn on OneDrive sync so reminders reach you when InkTasks is closed.";
    if (state.error) return "Couldn't reach the reminder service. It'll try again.";
    if (!state.push) return "This device can set reminders but isn't notified when InkTasks is closed.";
    return "";
  }

  return { soon, now, hint, state };
}
