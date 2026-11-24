// Reads dates, times, repeats and a list out of a new task's text, Microsoft To Do / Todoist style:
//   "Pay rent every month on the 1st at 9am #Bills"
//     -> title "Pay rent", due the next 1st, reminder 9:00 that day, repeats monthly, list Bills.
// Rules only (no AI): runs offline and instantly, and the text never leaves the device.
// Each recognised piece comes back as a chip; `keep` lists phrases the person tapped to keep as
// plain text, which are then skipped.
import { ymd, parseYmd, addDays } from "./model.js";

const DAY = "(?:sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:s|nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";
const MONTH = "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const DAY_NUM = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MONTH_NUM = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const NUM = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const num = s => NUM[s.toLowerCase()] || parseInt(s, 10);
const dayOf = s => DAY_NUM[s.slice(0, 3).toLowerCase()];
const B = "(?<![\\w#@])", E = "(?![\\w])";   // word edges
const PRE = "(?:(?:on|by|due|for)\\s+)?";       // "on Friday", "by Dec 5", "due tomorrow"

const pad = n => String(n).padStart(2, "0");
const validDate = (y, m, d) => { const x = new Date(y, m, d); return x.getMonth() === m && x.getDate() === d ? x : null; };
// The soonest date on or after today with this weekday.
const upcoming = (todayYmd, dow, skipToday = false) => {
  const t = parseYmd(todayYmd).getDay();
  let diff = (dow - t + 7) % 7;
  if (diff === 0 && skipToday) diff = 7;
  return addDays(todayYmd, diff);
};
// "next Friday": that day in the following week (weeks start on Monday).
function nextWeekday(todayYmd, dow) {
  const soon = upcoming(todayYmd, dow, true);
  const monday = d => { const x = parseYmd(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return ymd(x); };
  return monday(soon) === monday(todayYmd) ? addDays(soon, 7) : soon;
}
function monthDay(todayYmd, m, d, y) {
  const now = parseYmd(todayYmd);
  let date = validDate(y || now.getFullYear(), m, d);
  if (date && !y && ymd(date) < todayYmd) date = validDate(now.getFullYear() + 1, m, d);
  return date && ymd(date);
}
function ordinalDay(todayYmd, d) {
  const now = parseYmd(todayYmd);
  for (let i = 0; i < 13; i++) {   // this month if it's still to come, else the next month that has it
    const x = validDate(now.getFullYear(), now.getMonth() + i, d);
    if (x && ymd(x) >= todayYmd) return ymd(x);
  }
  return null;
}
function hour12(h, ap) {
  ap = ap.toLowerCase()[0];
  if (h < 1 || h > 12) return null;
  return ap === "p" ? (h % 12) + 12 : h % 12;
}
// "at 5" means 5pm, "at 9" means 9am: hours 1-7 are afternoon, 8-11 morning, 12 noon, 13-23 as is.
const guessHour = h => (h >= 1 && h <= 7 ? h + 12 : h <= 23 ? h : null);

export function parseTask(text, { now = new Date(), lists = [], keep = [] } = {}) {
  const todayYmd = ymd(now);
  const taken = [];   // { start, end, kind, text, ... }
  const free = (s, e) => !taken.some(t => s < t.end && e > t.start);
  for (const phrase of keep) {
    if (!phrase) continue;
    const low = text.toLowerCase(), p = phrase.toLowerCase();
    for (let i = low.indexOf(p); i >= 0; i = low.indexOf(p, i + 1)) taken.push({ start: i, end: i + p.length, kind: "kept" });
  }
  const has = kind => taken.some(t => t.kind === kind);
  // Runs one rule: the first free match whose handler accepts it becomes a chip of that kind.
  function rule(kind, source, fn) {
    if (has(kind)) return;
    const re = new RegExp(source, "gi");
    for (let m; (m = re.exec(text));) {
      if (!m[0].trim() || !free(m.index, m.index + m[0].length)) continue;
      const v = fn(m);
      if (v) { taken.push({ start: m.index, end: m.index + m[0].length, kind, text: m[0].trim(), ...v }); return; }
    }
  }

  // ----- repeats -----
  const unitOf = s => ({ d: "day", w: "week", m: "month", y: "year" })[s[0].toLowerCase()];
  rule("repeat", `${B}every\\s+(?:other|2nd|second)\\s+(day|week|month|year)${E}`, m => ({ repeat: { unit: unitOf(m[1]), every: 2 } }));
  rule("repeat", `${B}every\\s+(\\d+|two|three|four|five|six)\\s+(days?|weeks?|months?|years?)${E}`, m => ({ repeat: { unit: unitOf(m[2]), every: num(m[1]) } }));
  rule("repeat", `${B}(?:every\\s+weekday|(?:on\\s+)?weekdays)${E}`, () => ({ repeat: { unit: "week", every: 1, days: [1, 2, 3, 4, 5] } }));
  rule("repeat", `${B}every\\s+weekend${E}`, () => ({ repeat: { unit: "week", every: 1, days: [0, 6] } }));
  rule("repeat", `${B}every\\s+(${DAY}(?:\\s*(?:,|and|&|,\\s*and)\\s*${DAY})*)${E}`, m => {
    const days = [...new Set(m[1].match(new RegExp(DAY, "gi")).map(dayOf))].sort();
    return { repeat: { unit: "week", every: 1, days } };
  });
  rule("repeat", `${B}(?:every\\s+(day|week|month|year)|(daily|weekly|monthly|yearly|annually))${E}`, m => {
    const w = (m[1] || m[2]).toLowerCase();
    const unit = m[1] ? unitOf(m[1]) : { daily: "day", weekly: "week", monthly: "month", yearly: "year", annually: "year" }[w];
    return { repeat: { unit, every: 1 } };
  });

  // ----- list -----
  const norm = s => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  rule("list", `#([^\\s#]+)`, m => {
    const tag = norm(m[1]);
    const hit = lists.find(l => norm(l.name) === tag) || (tag.length >= 3 && lists.filter(l => norm(l.name).startsWith(tag)).length === 1
      ? lists.find(l => norm(l.name).startsWith(tag)) : null);
    return hit && { listId: hit.id, label: hit.name };
  });
  for (const l of [...lists].sort((a, b) => b.name.length - a.name.length)) {
    const name = l.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (!name) continue;
    rule("list", `${B}(?:in|to|on)\\s+(?:my\\s+|the\\s+)?${name}\\s+list${E}|${B}in\\s+(?:my\\s+|the\\s+)?${name}\\s*$`, () => ({ listId: l.id, label: l.name }));
  }

  // ----- date -----
  rule("date", `${B}${PRE}(?:the\\s+)?day\\s+after\\s+tomorrow${E}`, () => ({ due: addDays(todayYmd, 2) }));
  rule("date", `${B}${PRE}(today|tonight)${E}`, m => ({ due: todayYmd, today: true, tonight: m[1].toLowerCase() === "tonight" }));
  rule("date", `${B}${PRE}(?:tomorrow|tmrw|tmr|tomorow)${E}`, () => ({ due: addDays(todayYmd, 1) }));
  rule("date", `${B}in\\s+(\\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(days?|weeks?|months?)${E}`, m => {
    const n = num(m[1]), u = m[2][0].toLowerCase();
    if (u === "m") { const d = parseYmd(todayYmd); d.setMonth(d.getMonth() + n); return { due: ymd(d) }; }
    return { due: addDays(todayYmd, u === "w" ? 7 * n : n) };
  });
  rule("date", `${B}next\\s+(week|month|year)${E}`, m => {
    const u = m[1].toLowerCase(), d = parseYmd(todayYmd);
    if (u === "week") return { due: nextWeekday(todayYmd, 1) };
    if (u === "month") return { due: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 1)) };
    return { due: ymd(new Date(d.getFullYear() + 1, 0, 1)) };
  });
  rule("date", `${B}${PRE}(${MONTH})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?${E}`, m => {
    const due = monthDay(todayYmd, MONTH_NUM[m[1].slice(0, 3).toLowerCase()], +m[2], m[3] && +m[3]);
    return due && { due };
  });
  rule("date", `${B}${PRE}(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH})(?:,?\\s+(\\d{4}))?${E}`, m => {
    const due = monthDay(todayYmd, MONTH_NUM[m[2].slice(0, 3).toLowerCase()], +m[1], m[3] && +m[3]);
    return due && { due };
  });
  rule("date", `${B}${PRE}(\\d{1,2})\\/(\\d{1,2})(?:\\/(\\d{2}|\\d{4}))?${E}`, m => {
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : undefined;
    const due = monthDay(todayYmd, +m[1] - 1, +m[2], y);
    return due && { due };
  });
  rule("date", `${B}(?:on\\s+)?the\\s+(\\d{1,2})(?:st|nd|rd|th)${E}`, m => { const due = ordinalDay(todayYmd, +m[1]); return due && { due }; });
  rule("date", `${B}${PRE}(?:(this|next)\\s+)?(${DAY})${E}`, m => {
    // "Sun cream", "SAT prep", "wed": short day names that are also words need "on", "next"...
    if (/^(sun|sat|wed)$/i.test(m[2]) && m[0].trim().length === m[2].length) return false;
    const dow = dayOf(m[2]);
    return { due: m[1] && m[1].toLowerCase() === "next" ? nextWeekday(todayYmd, dow) : upcoming(todayYmd, dow) };
  });

  // ----- time -----
  rule("time", `${B}in\\s+(\\d+|an?|one|two|three|half\\s+an?)\\s+(hours?|hrs?|minutes?|mins?)${E}`, m => {
    const n = /^half/i.test(m[1]) ? 0.5 : num(m[1]);
    const ms = n * (/^h/i.test(m[2]) ? 3600e3 : 60e3);
    return { at: new Date(Math.ceil((now.getTime() + ms) / 60e3) * 60e3) };
  });
  rule("time", `${B}(?:(?:at|by)\\s+|@\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)(?!\\w)`, m => {
    const h = hour12(+m[1], m[3]), min = +(m[2] || 0);
    return h !== null && min < 60 && { h, min };
  });
  rule("time", `${B}(?:at|@)\\s*(\\d{1,2})(?::(\\d{2}))?${E}`, m => {
    const h = m[2] && +m[1] >= 13 ? +m[1] : guessHour(+m[1]), min = +(m[2] || 0);
    return h !== null && h <= 23 && min < 60 && { h, min };
  });
  rule("time", `${B}(\\d{1,2}):(\\d{2})${E}`, m => {
    const h = +m[1] >= 13 ? +m[1] : guessHour(+m[1]), min = +m[2];
    return h !== null && h <= 23 && min < 60 && { h, min };
  });
  rule("time", `${B}(?:at\\s+)?(noon|midday|midnight)${E}`, m => ({ h: /night/i.test(m[1]) ? 0 : 12, min: 0 }));
  rule("time", `${B}(?:in\\s+the\\s+|this\\s+)?(morning|afternoon|evening)${E}`, m => {
    const prefixed = /^(in|this)\s/i.test(m[0]);
    const afterDate = taken.some(t => t.kind === "date" && /^\s*$/.test(text.slice(t.end, m.index)));
    if (!prefixed && !afterDate) return false;   // "Plan evening walk" stays as it is
    return { h: { morning: 9, afternoon: 14, evening: 18 }[m[1].toLowerCase()], min: 0 };
  });

  // ----- important -----
  rule("important", `(?:^|\\s)(!{1,3})(?=\\s|$)`, () => ({}));

  // ----- put it together -----
  const get = kind => taken.find(t => t.kind === kind);
  const date = get("date"), time = get("time"), repeat = get("repeat"), list = get("list");
  const out = { title: "", due: null, remind: null, repeat: null, listId: null, important: !!get("important"), myDay: null, chips: [] };
  if (repeat) out.repeat = repeat.repeat;
  if (list) out.listId = list.listId;
  let due = date ? date.due : null;
  if (!due && repeat) {   // a repeating task starts on its first day
    const r = repeat.repeat;
    due = r.unit === "week" && r.days ? r.days.map(d => upcoming(todayYmd, d)).sort()[0] : todayYmd;
  }
  out.due = due;
  if (date && date.today) out.myDay = todayYmd;
  let hm = time && time.h !== undefined ? time : date && date.tonight ? { h: 20, min: 0 } : null;
  if (time && time.at) {
    out.remind = `${ymd(time.at)}T${pad(time.at.getHours())}:${pad(time.at.getMinutes())}`;
  } else if (hm) {
    let day = due || todayYmd;
    if (!due && new Date(`${day}T${pad(hm.h)}:${pad(hm.min)}`) <= now) day = addDays(day, 1);   // "at 9am" when it's past 9: tomorrow
    out.remind = `${day}T${pad(hm.h)}:${pad(hm.min)}`;
  }
  for (const t of taken) if (t.kind !== "kept") out.chips.push({ kind: t.kind, text: t.text, label: t.label });
  out.chips.sort((a, b) => text.toLowerCase().indexOf(a.text.toLowerCase()) - text.toLowerCase().indexOf(b.text.toLowerCase()));

  // Title: the text without the recognised pieces and the little words they leave behind.
  let title = "", pos = 0;
  for (const t of taken.filter(t => t.kind !== "kept").sort((a, b) => a.start - b.start)) { title += text.slice(pos, t.start) + " "; pos = t.end; }
  title += text.slice(pos);
  title = title.replace(/\s+/g, " ").replace(/\s+([,.;:!?])/g, "$1").trim();
  if (out.remind) title = title.replace(/^(?:please\s+)?remind\s+me\s+(?:to\s+)?/i, "");
  for (let i = 0; i < 3; i++) {
    title = title.replace(/[\s,;:\-–—]+$/, "").replace(/^[\s,;:\-–—]+/, "")
      .replace(/\s+(?:on|at|by|in|due|for|every|and|from|starting)$/i, "")
      .replace(/^(?:on|at|by|due)\s+/i, "");
  }
  out.title = title || text.trim();
  if (out.title === text.trim()) out.chips = out.chips.filter(c => c.kind !== "kept");
  return out;
}
