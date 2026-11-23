// Reminder helpers shared by the app (reminders.js) and the service worker (sw.js).
import { sealJSON, toB64 } from "/inknotes/js/crypt.js";

export const SNOOZE_MINUTES = 10;

// When a task's reminder should fire (ms), or null. `remind` is local time "YYYY-MM-DDTHH:MM".
export const remindAt = t => (t && t.kind === "task" && t.remind && !t.done && !t.deleted ? new Date(t.remind).getTime() || null : null);
const pad = n => String(n).padStart(2, "0");
export const localStamp = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
// The title, sealed with the sync key so the reminder service can't read it.
export const sealReminder = async (key, t) => toB64(await sealJSON(key, { title: t.title || "Untitled task", taskId: t.id }, "reminder/" + t.id));
