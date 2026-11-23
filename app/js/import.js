// One-time copy of Microsoft To Do into InkTasks (Microsoft Graph, Tasks.Read). Read-only on the
// Microsoft side. Each imported list and task gets an id made from its Microsoft id, so running
// the import again only adds what's new and never duplicates.

import { accessToken } from "/inknotes/js/auth.js";
import { GRAPH } from "/inknotes/js/config.js";
import { db, newTask, newId } from "./db.js";

const DAYS = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function idFor(msId) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(msId)));
  return "ms-" + [...h.slice(0, 12)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getAll(url) {
  const out = [];
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: "Bearer " + await accessToken(), Prefer: `outlook.timezone="${TZ}"` },
    });
    if (!res.ok) {
      const e = new Error(res.status === 403 || res.status === 401
        ? "Microsoft didn't allow reading your tasks. Try the import again and accept the permission."
        : `Reading Microsoft To Do failed (${res.status}).`);
      e.status = res.status;
      throw e;
    }
    const j = await res.json();
    out.push(...(j.value || []));
    url = j["@odata.nextLink"];
  }
  return out;
}

const dateOf = dt => (dt && dt.dateTime ? dt.dateTime.slice(0, 10) : null);
const timeOf = dt => (dt && dt.dateTime ? dt.dateTime.slice(0, 16) : null);

function textOf(body) {
  if (!body || !body.content) return "";
  if (body.contentType !== "html") return body.content.trim();
  const d = new DOMParser().parseFromString(body.content, "text/html");
  d.querySelectorAll("br").forEach(b => b.replaceWith("\n"));
  d.querySelectorAll("p, div, li").forEach(b => b.append("\n"));
  return d.body.textContent.replace(/\n{3,}/g, "\n\n").trim();
}

function repeatOf(rec) {
  const p = rec && rec.pattern;
  if (!p) return null;
  const every = p.interval || 1;
  switch (p.type) {
    case "daily": return { unit: "day", every };
    case "weekly": {
      const days = (p.daysOfWeek || []).map(d => DAYS[d]).filter(n => n !== undefined).sort();
      return days.length ? { unit: "week", every, days } : { unit: "week", every };
    }
    case "absoluteMonthly": case "relativeMonthly": return { unit: "month", every };
    case "absoluteYearly": case "relativeYearly": return { unit: "year", every };
    default: return null;
  }
}

// onProgress(fraction 0..1, message)
export async function importFromToDo(onProgress = () => {}) {
  const lists = (await getAll(`${GRAPH}/me/todo/lists`)).filter(l => l.wellknownListName !== "flaggedEmails");
  const existing = new Map((await db.all()).map(i => [i.id, i]));
  const now = Date.now(), toPut = [];
  let listCount = 0, taskCount = 0, skipped = 0;

  for (const [i, l] of lists.entries()) {
    onProgress(i / Math.max(1, lists.length), `Reading “${l.displayName}”`);
    const listId = l.wellknownListName === "defaultList" ? "inbox" : await idFor(l.id);
    if (listId !== "inbox" && !existing.has(listId)) {
      toPut.push({ id: listId, kind: "list", name: l.displayName || "Imported list", order: now + i,
        created: now, updated: now, deleted: false, msId: l.id });
      listCount++;
    }
    const tasks = await getAll(`${GRAPH}/me/todo/lists/${encodeURIComponent(l.id)}/tasks?$expand=checklistItems&$top=100`);
    for (const t of tasks) {
      const id = await idFor(t.id);
      if (existing.has(id)) { skipped++; continue; }
      const created = Date.parse(t.createdDateTime) || now;
      const done = t.status === "completed";
      toPut.push(newTask({
        id, listId,
        title: (t.title || "").trim() || "Untitled task",
        done, doneAt: done ? (Date.parse(timeOf(t.completedDateTime)) || Date.parse(t.lastModifiedDateTime) || now) : null,
        important: t.importance === "high",
        due: dateOf(t.dueDateTime),
        repeat: repeatOf(t.recurrence),
        remind: t.isReminderOn ? timeOf(t.reminderDateTime) : null,
        notes: textOf(t.body),
        steps: (t.checklistItems || []).map(c => ({ id: newId(), title: c.displayName || "", done: !!c.isChecked })),
        order: -created, created, updated: now, msId: t.id,
      }));
      taskCount++;
    }
  }
  onProgress(1, "Saving");
  if (toPut.length) await db.putMany(toPut);
  return { lists: listCount, tasks: taskCount, skipped, ids: toPut.map(x => x.id) };
}
