// What the buttons on a reminder notification do. Used by the service worker; kept apart so it
// can be tested from a page.
import { store } from "/inknotes/js/store.js";
import { db, announce } from "./db.js";
import { REMINDER_SERVICE } from "./config.js";
import { SNOOZE_MINUTES, localStamp, sealReminder } from "./reminders-core.js";

// Tells the service about one task's reminder (at: ms, or null to cancel) and remembers that it
// did. If it can't, nothing is lost: the task itself changed, so InkTasks sends it next time.
async function tell(t, at) {
  const dev = await store.getMeta("reminders:device"), key = await store.getMeta("key");
  if (!REMINDER_SERVICE || !dev || !key) return;
  const item = { id: t.id, at, updated: t.updated, payload: at ? await sealReminder(key, t) : undefined };
  try {
    const res = await fetch(REMINDER_SERVICE.replace(/\/$/, "") + "/reminders", {
      method: "POST", body: JSON.stringify({ items: [item] }),
      headers: { "Content-Type": "application/json", Authorization: `Device ${dev.device}:${dev.token}` },
    });
    if (res.ok) {
      const sent = (await store.getMeta("reminders:sent")) || {};
      sent[t.id] = { at, title: t.title };
      await store.setMeta("reminders:sent", sent);
    }
  } catch (err) { console.warn("Reminder change not sent yet", err); }
}

// Complete: marks the task done. Returns "done", "open" (a repeating task: InkTasks makes the next
// copy, so open it there) or "missing".
export async function completeFromNotification(id) {
  const t = await db.get(id);
  if (!t || t.deleted) return "missing";
  if (t.repeat) return "open";
  if (t.done) return "done";
  t.done = true; t.doneAt = Date.now(); t.updated = Date.now();
  await db.put(t);
  announce([id], "sw");
  await tell(t, null);
  return "done";
}

// Snooze: moves the reminder on.
export async function snooze(id) {
  const t = await db.get(id);
  if (!t || t.deleted || t.done) return;
  const stamp = localStamp(Date.now() + SNOOZE_MINUTES * 60e3);
  t.remind = stamp; t.updated = Date.now();
  await db.put(t);
  announce([id], "sw");
  await tell(t, new Date(stamp).getTime());
}
