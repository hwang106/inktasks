// Dates, repeats and the built-in views. No DOM here.

const pad = n => String(n).padStart(2, "0");
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
export const today = () => ymd(new Date());
export function addDays(s, n) { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); }
function addMonths(s, n) {
  const d = parseYmd(s), day = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, last));
  return ymd(d);
}

// The next due date for a repeating task, counted from its due date (or today).
export function nextDue(task) {
  const r = task.repeat; if (!r) return null;
  const base = task.due || today(), every = Math.max(1, r.every || 1);
  if (r.unit === "day") return addDays(base, every);
  if (r.unit === "month") return addMonths(base, every);
  if (r.unit === "year") return addMonths(base, 12 * every);
  if (r.unit === "week") {
    const days = (r.days && r.days.length ? r.days : [parseYmd(base).getDay()]).slice().sort();
    const dow = parseYmd(base).getDay();
    const later = days.find(d => d > dow);
    if (later !== undefined) return addDays(base, later - dow);
    return addDays(base, 7 * (every - 1) + (7 - dow) + days[0]);   // first chosen day of the next round
  }
  return null;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const REPEATS = {
  "": null,
  daily: { unit: "day", every: 1 },
  weekdays: { unit: "week", every: 1, days: [1, 2, 3, 4, 5] },
  weekly: { unit: "week", every: 1 },
  monthly: { unit: "month", every: 1 },
  yearly: { unit: "year", every: 1 },
};
export function repeatKey(r) {
  if (!r) return "";
  for (const [k, v] of Object.entries(REPEATS)) {
    if (v && v.unit === r.unit && (r.every || 1) === v.every && String(v.days || "") === String(r.days || "")) return k;
  }
  if (r.unit === "week" && (r.every || 1) === 1 && r.days && r.days.length === 1) return "weekly";
  return "custom";
}
export function repeatLabel(r) {
  if (!r) return "";
  const k = repeatKey(r);
  if (k && k !== "custom") return { daily: "Daily", weekdays: "Weekdays", weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" }[k];
  const unit = { day: "day", week: "week", month: "month", year: "year" }[r.unit];
  let s = `Every ${r.every > 1 ? r.every + " " + unit + "s" : unit}`;
  if (r.days && r.days.length) s += " on " + r.days.map(d => DAY_NAMES[d]).join(", ");
  return s;
}

export function dueLabel(due) {
  if (!due) return "";
  const t = today();
  if (due === t) return "Today";
  if (due === addDays(t, 1)) return "Tomorrow";
  if (due === addDays(t, -1)) return "Yesterday";
  const d = parseYmd(due), now = new Date();
  const diff = (d - parseYmd(t)) / 864e5;
  if (diff > 1 && diff < 7) return d.toLocaleDateString([], { weekday: "long" });
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}
export const isOverdue = t => !!t.due && !t.done && t.due < today();

// Built-in views. `filter` picks tasks; `defaults` are what a task added in that view starts with.
export const SMART = [
  { id: "myday", name: "My Day", icon: "sun", filter: t => t.myDay === today(), defaults: () => ({ myDay: today() }) },
  { id: "important", name: "Important", icon: "star", filter: t => t.important, defaults: () => ({ important: true }) },
  { id: "planned", name: "Planned", icon: "calendar", filter: t => !!t.due, defaults: () => ({ due: today() }), byDue: true },
  { id: "inbox", name: "Tasks", icon: "home", filter: t => t.listId === "inbox", defaults: () => ({}), isList: true },
];
