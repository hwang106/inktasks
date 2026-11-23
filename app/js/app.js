import { db, hooks as dbHooks, announce, newTask, newId } from "./db.js";
import { SMART, today, nextDue, dueLabel, isOverdue, repeatKey, repeatLabel, REPEATS, parseYmd } from "./model.js";
import { createSync } from "/inknotes/js/sync.js";
import { mountSyncUI } from "/inknotes/js/sync-ui.js";

const el = Object.fromEntries([...document.querySelectorAll("[id]")].map(e => [e.id, e]));
const { app } = el;
const windowId = newId();
const items = new Map();
let view = "myday", selected = null, query = "";
const NARROW = matchMedia("(max-width: 760px)");

// ---------- data ----------
const tasks = () => [...items.values()].filter(i => i.kind === "task" && !i.deleted);
const userLists = () => [...items.values()].filter(i => i.kind === "list" && !i.deleted && i.id !== "inbox")
  .sort((a, b) => (a.order || 0) - (b.order || 0) || a.created - b.created);
const smart = id => SMART.find(s => s.id === id);
function listName(id) {
  const l = items.get(id);
  if (id === "inbox") return (l && !l.deleted && l.name) || "Tasks";
  return l && !l.deleted ? l.name : "Tasks";
}
function ensureInbox() {
  if (!items.has("inbox")) {
    const inbox = { id: "inbox", kind: "list", name: "Tasks", order: 0, created: 0, updated: 0, deleted: false, welcome: true };
    items.set("inbox", inbox); db.put(inbox);
  }
}
function inView(t, v = view) {
  const s = smart(v);
  if (s) return s.filter(t);
  return t.listId === v;
}
function viewTasks() {
  if (query) {
    const q = query.toLowerCase();
    return tasks().filter(t => (t.title + "\n" + (t.notes || "") + "\n" + (t.steps || []).map(s => s.title).join("\n")).toLowerCase().includes(q));
  }
  return tasks().filter(t => inView(t));
}

// ---------- saving ----------
const timers = new Map();
async function save(item, { now = true } = {}) {
  item.updated = Date.now();
  clearTimeout(timers.get(item.id));
  if (!now) { timers.set(item.id, setTimeout(() => save(item), 400)); return; }
  timers.delete(item.id);
  try {
    await db.put(item);
    announce([item.id], windowId);
    sync.soon();
  } catch (err) {
    toast("Couldn't save on this device. Check that the browser allows site storage.");
  }
}
function flushSaves() {
  return Promise.all([...timers.keys()].map(id => items.get(id)).filter(Boolean).map(i => save(i)));
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSaves(); });
addEventListener("pagehide", () => { flushSaves(); });

async function reload(ids) {
  for (const id of ids) {
    if (timers.has(id)) continue;   // being edited here; this window's copy saves next
    const it = await db.get(id);
    if (it) items.set(id, it);
  }
  render();
}
if ("BroadcastChannel" in window) {
  const ch = new BroadcastChannel("inktasks");
  ch.onmessage = ({ data }) => { if (data && data.type === "changed" && data.from !== windowId) reload(data.ids || []); };
}

// ---------- sidebar ----------
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
function listButton(id, name, iconName, count) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "list-btn"; b.dataset.id = id;
  b.setAttribute("aria-current", String(!query && view === id));
  b.innerHTML = `${icon(iconName)}<span class="name"></span><span class="count"></span>`;
  b.querySelector(".name").textContent = name;
  b.querySelector(".count").textContent = count || "";
  b.onclick = () => selectView(id);
  return b;
}
function renderSidebar() {
  const active = tasks().filter(t => !t.done);
  el.smartLists.replaceChildren(...SMART.map(s =>
    listButton(s.id, s.id === "inbox" ? listName("inbox") : s.name, s.icon, active.filter(s.filter).length)));
  el.userLists.replaceChildren(...userLists().map(l =>
    listButton(l.id, l.name, "list", active.filter(t => t.listId === l.id).length)));
}
function selectView(id) {
  flushSaves();
  view = id; query = ""; el.search.value = "";
  closeDetail();
  app.dataset.view = "tasks";
  render();
  if (!NARROW.matches) el.addInput.focus();
}

// ---------- tasks ----------
function metaFor(t) {
  const bits = [];
  if (query || smart(view) && view !== "inbox") bits.push(`<span>${escapeHtml(listName(t.listId))}</span>`);
  if (t.myDay === today() && view !== "myday") bits.push(`<span>${icon("sun")}My Day</span>`);
  if (t.steps && t.steps.length) bits.push(`<span>${t.steps.filter(s => s.done).length} of ${t.steps.length}</span>`);
  if (t.due) {
    const cls = isOverdue(t) ? "overdue" : t.due === today() && !t.done ? "today" : "";
    bits.push(`<span class="${cls}">${icon("calendar")}${escapeHtml(dueLabel(t.due))}</span>`);
  }
  if (t.repeat) bits.push(`<span title="${escapeHtml(repeatLabel(t.repeat))}">${icon("repeat")}</span>`);
  if (t.remind) bits.push(`<span title="Reminder">${icon("bell")}</span>`);
  if (t.notes) bits.push(`<span title="Has a note">${icon("note")}</span>`);
  if (t.noteId) bits.push(`<span title="From InkNotes">${icon("note")}InkNotes</span>`);
  return bits.join("");
}
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function taskRow(t) {
  const li = document.createElement("li");
  li.className = "task" + (t.done ? " done" : ""); li.dataset.id = t.id;
  li.setAttribute("aria-current", String(selected === t.id));
  li.innerHTML = `
    <button class="check" type="button" aria-pressed="${t.done}" aria-label="${t.done ? "Mark not completed" : "Mark completed"}">${icon("check")}</button>
    <div class="main"><div class="title"></div><div class="meta">${metaFor(t)}</div></div>
    <button class="star" type="button" aria-pressed="${t.important}" aria-label="${t.important ? "Remove importance" : "Mark as important"}">${icon("star")}</button>`;
  li.querySelector(".title").textContent = t.title;
  if (!li.querySelector(".meta").innerHTML) li.querySelector(".meta").remove();
  li.querySelector(".check").onclick = e => { e.stopPropagation(); e.currentTarget.classList.add("pop"); toggleDone(t); };
  li.querySelector(".star").onclick = e => { e.stopPropagation(); t.important = !t.important; save(t); render(); };
  li.onclick = () => openDetail(t.id);
  return li;
}

const EMPTY = {
  myday: "Focus on your day. Add tasks here, or add them to My Day from any list.",
  important: "Star a task to see it here.",
  planned: "Tasks with a due date show up here.",
};
function renderTasks() {
  const s = smart(view);
  const isUserList = !s && !query;
  el.listTitle.textContent = query ? "Search" : s ? (view === "inbox" ? listName("inbox") : s.name) : listName(view);
  el.listTitle.classList.toggle("editable", isUserList || (!query && view === "inbox"));
  el.listSub.textContent = query ? `Results for “${query}”` : view === "myday"
    ? new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }) : "";
  el.listSub.hidden = !el.listSub.textContent;
  el.listMenu.hidden = !(isUserList || (!query && view === "inbox"));
  el.deleteList.hidden = view === "inbox";
  el.addForm.hidden = !!query;

  const all = viewTasks();
  const active = all.filter(t => !t.done), done = all.filter(t => t.done);
  if (s && s.byDue && !query) active.sort((a, b) => a.due.localeCompare(b.due) || a.order - b.order);
  else active.sort((a, b) => a.order - b.order);
  done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  el.taskList.replaceChildren(...active.map(taskRow));
  el.doneList.replaceChildren(...done.map(taskRow));
  el.doneSection.hidden = !done.length;
  el.doneCount.textContent = done.length;
  el.emptyMsg.hidden = !!active.length;
  el.emptyMsg.textContent = query ? (done.length ? "Only completed tasks match." : "No tasks match.")
    : done.length ? "All done here." : EMPTY[view] || "No tasks yet. Add one above.";
  document.title = el.listTitle.textContent + " – InkTasks";
}

el.addForm.addEventListener("submit", e => {
  e.preventDefault();
  const title = el.addInput.value.trim();
  if (!title) return;
  const s = smart(view);
  const t = newTask({ title, listId: s ? "inbox" : view, ...(s ? s.defaults() : {}) });
  items.set(t.id, t); save(t);
  el.addInput.value = "";
  render();
});

function toggleDone(t) {
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  save(t);
  if (t.done && t.repeat) {
    const due = nextDue(t);
    const next = newTask({
      title: t.title, listId: t.listId, important: t.important, notes: t.notes, repeat: t.repeat, due,
      steps: (t.steps || []).map(s => ({ ...s, id: newId(), done: false })), order: t.order,
      noteId: t.noteId, noteTitle: t.noteTitle,
    });
    t.repeat = null;   // the repeat moves on to the new copy, as in Microsoft To Do
    save(t); items.set(next.id, next); save(next);
    if (selected === t.id) selected = next.id;
    const label = dueLabel(due);
    toast(`Done. The next one is due ${/^(Today|Tomorrow)$/.test(label) ? label.toLowerCase() : label}.`);
  }
  setTimeout(render, 180);   // let the tick show before the task moves
}

// ---------- list title, rename, delete ----------
function startRename() {
  if (el.listMenu.hidden) return;
  el.listMenu.open = false;
  el.listTitleEdit.value = listName(view);
  el.listTitle.hidden = true; el.listTitleEdit.hidden = false;
  el.listTitleEdit.focus(); el.listTitleEdit.select();
}
function endRename(keep) {
  if (el.listTitleEdit.hidden) return;
  const name = el.listTitleEdit.value.trim();
  el.listTitleEdit.hidden = true; el.listTitle.hidden = false;
  const l = items.get(view);
  if (keep && name && l && name !== l.name) { l.name = name; delete l.welcome; save(l); }
  render();
}
el.listTitle.addEventListener("click", startRename);
el.renameList.onclick = startRename;
el.listTitleEdit.addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); endRename(true); }
  if (e.key === "Escape") { e.preventDefault(); endRename(false); }
});
el.listTitleEdit.addEventListener("blur", () => endRename(true));
el.newList.onclick = () => {
  const l = { id: newId(), kind: "list", name: "Untitled list", order: Date.now(), created: Date.now(), updated: Date.now(), deleted: false };
  items.set(l.id, l); save(l);
  selectView(l.id);
  startRename();
};
let delListArmed = 0;
el.deleteList.onclick = () => {
  if (!delListArmed) {
    el.deleteList.textContent = "Select again to delete"; el.deleteList.classList.add("armed");
    delListArmed = setTimeout(() => { delListArmed = 0; el.deleteList.textContent = "Delete list"; el.deleteList.classList.remove("armed"); }, 3000);
    return;
  }
  clearTimeout(delListArmed); delListArmed = 0;
  el.deleteList.textContent = "Delete list"; el.deleteList.classList.remove("armed");
  const l = items.get(view); if (!l) return;
  const gone = [l, ...tasks().filter(t => t.listId === l.id)];
  gone.forEach(i => { i.deleted = true; save(i); });
  el.listMenu.open = false;
  selectView("myday");
  toast(`Deleted “${l.name}”.`, "Undo", () => { gone.forEach(i => { i.deleted = false; save(i); }); selectView(l.id); });
};

// ---------- details ----------
function openDetail(id) {
  flushSaves();
  selected = id;
  el.detail.hidden = false;
  app.dataset.view = "detail";
  renderDetail();
  renderTasks();
}
function closeDetail() {
  if (!selected) return;
  flushSaves();
  selected = null;
  el.detail.hidden = true;
  if (app.dataset.view === "detail") app.dataset.view = "tasks";
  resetDelete();
  renderTasks();
}
el.detailClose.onclick = closeDetail;

function autosize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
function renderDetail() {
  const t = items.get(selected);
  if (!t || t.deleted) { closeDetail(); return; }
  const active = document.activeElement;
  el.dDone.setAttribute("aria-pressed", String(t.done));
  el.dStar.setAttribute("aria-pressed", String(t.important));
  if (active !== el.dTitle) { el.dTitle.value = t.title; }
  autosize(el.dTitle);
  el.dTitle.classList.toggle("done", t.done);
  // steps
  if (!el.dSteps.contains(active)) el.dSteps.replaceChildren(...(t.steps || []).map(s => stepRow(t, s)));
  const inDay = t.myDay === today();
  el.dMyDay.setAttribute("aria-pressed", String(inDay));
  el.dMyDay.querySelector("span").textContent = inDay ? "Added to My Day" : "Add to My Day";
  el.dDue.value = t.due || "";
  el.dDueClear.hidden = !t.due;
  const rk = repeatKey(t.repeat);
  const custom = el.dRepeat.querySelector('option[value="custom"]');
  custom.hidden = rk !== "custom"; custom.textContent = rk === "custom" ? repeatLabel(t.repeat) : "Custom";
  el.dRepeat.value = rk;
  el.dList.replaceChildren(...[{ id: "inbox", name: listName("inbox") }, ...userLists()].map(l => {
    const o = document.createElement("option"); o.value = l.id; o.textContent = l.name; return o;
  }));
  el.dList.value = items.get(t.listId) && !items.get(t.listId).deleted ? t.listId : "inbox";
  el.dRemindText.textContent = t.remind
    ? new Date(t.remind).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " (reminders coming soon)"
    : "Coming soon";
  if (active !== el.dNotes) el.dNotes.value = t.notes || "";
  el.dSource.hidden = !t.noteId;
  if (t.noteId) {
    el.dSource.href = `/inknotes/?note=${encodeURIComponent(t.noteId)}`;
    el.dSource.querySelector("span").textContent = "From note: " + (t.noteTitle || "open in InkNotes");
  }
  el.dCreated.textContent = t.done && t.doneAt
    ? "Completed " + new Date(t.doneAt).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })
    : "Created " + new Date(t.created).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function stepRow(t, s) {
  const li = document.createElement("li");
  li.className = "step" + (s.done ? " done" : "");
  li.innerHTML = `<button class="check" type="button" aria-pressed="${s.done}" aria-label="${s.done ? "Mark step not done" : "Mark step done"}">${icon("check")}</button>
    <input type="text" maxlength="255" aria-label="Step">
    <button class="icon-btn small" type="button" aria-label="Delete step" title="Delete step">${icon("close")}</button>`;
  const input = li.querySelector("input"); input.value = s.title;
  li.querySelector(".check").onclick = () => { s.done = !s.done; save(t); renderDetail(); renderTasks(); };
  input.addEventListener("input", () => { s.title = input.value; save(t, { now: false }); });
  input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.stepInput.focus(); } });
  input.addEventListener("blur", () => { if (!input.value.trim()) { t.steps = t.steps.filter(x => x !== s); save(t); renderDetail(); renderTasks(); } });
  li.querySelector(".icon-btn").onclick = () => { t.steps = t.steps.filter(x => x !== s); save(t); renderDetail(); renderTasks(); };
  return li;
}
const cur = () => items.get(selected);
el.dDone.onclick = () => { const t = cur(); if (t) { toggleDone(t); renderDetail(); } };
el.dStar.onclick = () => { const t = cur(); if (t) { t.important = !t.important; save(t); renderDetail(); renderTasks(); renderSidebar(); } };
el.dTitle.addEventListener("input", () => {
  const t = cur(); if (!t) return;
  el.dTitle.value = el.dTitle.value.replace(/\n/g, " ");
  autosize(el.dTitle);
  if (el.dTitle.value.trim()) { t.title = el.dTitle.value.trim(); save(t, { now: false }); renderTasks(); }
});
el.dTitle.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.dTitle.blur(); } });
el.dTitle.addEventListener("blur", () => { const t = cur(); if (t) el.dTitle.value = t.title; });
el.stepForm.addEventListener("submit", e => {
  e.preventDefault();
  const t = cur(), title = el.stepInput.value.trim(); if (!t || !title) return;
  t.steps = [...(t.steps || []), { id: newId(), title, done: false }];
  el.stepInput.value = "";
  save(t); renderDetail(); renderTasks();
});
el.dMyDay.onclick = () => { const t = cur(); if (!t) return; t.myDay = t.myDay === today() ? null : today(); save(t); renderDetail(); render(); };
el.dDue.addEventListener("change", () => { const t = cur(); if (!t) return; t.due = el.dDue.value || null; save(t); renderDetail(); render(); });
el.dDueClear.onclick = e => { e.preventDefault(); const t = cur(); if (!t) return; t.due = null; save(t); renderDetail(); render(); };
el.dRepeat.addEventListener("change", () => {
  const t = cur(); if (!t) return;
  const v = el.dRepeat.value; if (v === "custom") return;
  t.repeat = REPEATS[v] ? { ...REPEATS[v] } : null;
  if (t.repeat && !t.due) t.due = today();   // a repeat needs a starting date
  save(t); renderDetail(); render();
});
el.dList.addEventListener("change", () => { const t = cur(); if (!t) return; t.listId = el.dList.value; save(t); render(); });
el.dNotes.addEventListener("input", () => { const t = cur(); if (!t) return; t.notes = el.dNotes.value; save(t, { now: false }); });
el.dNotes.addEventListener("blur", () => { flushSaves(); renderTasks(); });

let delArmed = 0;
function resetDelete() { clearTimeout(delArmed); delArmed = 0; el.dDelete.classList.remove("armed"); el.dDelete.title = "Delete task"; }
el.dDelete.onclick = () => {
  if (!delArmed) { el.dDelete.classList.add("armed"); el.dDelete.title = "Select again to delete"; delArmed = setTimeout(resetDelete, 3000); toast("Select the bin again to delete this task."); return; }
  resetDelete();
  const t = cur(); if (!t) return;
  t.deleted = true; save(t);
  closeDetail(); render();
  toast(`Deleted “${t.title}”.`, "Undo", () => { t.deleted = false; save(t); render(); openDetail(t.id); });
};

// ---------- search, navigation, keys ----------
el.search.addEventListener("input", () => {
  query = el.search.value.trim();
  if (query) app.dataset.view = "tasks";
  render();
});
el.backToLists.onclick = () => { flushSaves(); app.dataset.view = "lists"; closeDetail(); renderSidebar(); };
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && selected && !e.target.closest("dialog")) { if (e.target === el.listTitleEdit) return; closeDetail(); }
});
document.addEventListener("pointerdown", e => { if (el.listMenu.open && !el.listMenu.contains(e.target)) el.listMenu.open = false; });

function render() {
  renderSidebar();
  renderTasks();
  if (selected) renderDetail();
}

// ---------- toast ----------
let toastTimer = 0;
function toast(msg, action, fn) {
  el.toastText.textContent = msg;
  el.toastAction.hidden = !action;
  if (action) { el.toastAction.textContent = action; el.toastAction.onclick = () => { el.toast.hidden = true; fn(); }; }
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, 6000);
}

// ---------- storage upgrades held up by other windows ----------
const BLOCKED_MSG = "InkTasks was updated. Close or reload any other InkTasks windows to finish.";
dbHooks.onBlocked = () => { el.storageNote.hidden = false; el.storageNote.textContent = BLOCKED_MSG; toast(BLOCKED_MSG); clearTimeout(toastTimer); };
dbHooks.onUnblocked = () => { if (el.storageNote.textContent === BLOCKED_MSG) el.storageNote.hidden = true; };
dbHooks.onVersionChange = () => {
  toast("InkTasks was updated in another window. Reload this one to keep saving.", "Reload", () => location.reload());
  clearTimeout(toastTimer);
};

// ---------- OneDrive sync ----------
const sync = createSync({ folder: "todo", stateKey: "syncState:todo", local: db });
const syncUI = mountSyncUI({ sync, button: el.syncBtn, appName: "your tasks", toast, beforeSignIn: flushSaves });

// ---------- import from Microsoft To Do ----------
el.importBtn.onclick = () => {
  el.importText.textContent = "Copies your lists and tasks into InkTasks: steps, notes, due dates, repeats, and which tasks are important or done. Microsoft To Do isn't changed.";
  el.importHint.hidden = false; el.importProgress.hidden = true;
  el.importGo.hidden = false; el.importGo.disabled = false; el.importGo.textContent = "Continue to Microsoft";
  el.importClose.textContent = "Cancel";
  el.importDialog.showModal();
};
el.importClose.onclick = () => el.importDialog.close();
el.importDialog.querySelector("form").addEventListener("submit", async e => {
  e.preventDefault();
  await flushSaves();
  sync.signIn({ extraScopes: "Tasks.Read", purpose: "import" });
});
async function runImport() {
  el.importText.textContent = "Copying from Microsoft To Do…";
  el.importHint.hidden = true; el.importProgress.hidden = false; el.importGo.hidden = true;
  el.importClose.textContent = "Close"; el.importClose.disabled = true;
  if (!el.importDialog.open) el.importDialog.showModal();
  const bar = el.importProgress.querySelector("span");
  try {
    const { importFromToDo } = await import("./import.js");
    const res = await importFromToDo((f, msg) => { bar.style.width = Math.round(f * 100) + "%"; el.importText.textContent = msg + "…"; });
    for (const id of res.ids) items.set(id, await db.get(id));
    announce(res.ids, windowId);
    render();
    const parts = [`${res.tasks} task${res.tasks === 1 ? "" : "s"}`];
    if (res.lists) parts.push(`${res.lists} list${res.lists === 1 ? "" : "s"}`);
    el.importText.textContent = res.tasks || res.lists
      ? `Imported ${parts.join(" in ")}.` + (res.skipped ? ` ${res.skipped} were already here.` : "")
      : res.skipped ? "Everything was already imported." : "Microsoft To Do had nothing to import.";
    el.importHint.hidden = false;
    el.importHint.textContent = "Microsoft To Do is unchanged. Imported tasks sync to your other devices if OneDrive sync is on.";
    sync.soon();
  } catch (err) {
    el.importText.textContent = err.message || "The import didn't finish.";
  } finally {
    el.importProgress.hidden = true; el.importClose.disabled = false;
  }
}

// ---------- start ----------
async function init() {
  let all = [];
  try { all = await db.all(); } catch (err) { console.warn(err); }
  for (const i of all) items.set(i.id, i);
  ensureInbox();
  if (!db.persistent) {
    el.storageNote.hidden = false;
    el.storageNote.textContent = "This browser is blocking site storage, so tasks will be lost when it closes.";
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const params = new URLSearchParams(location.search);
  const want = params.get("task");
  app.dataset.view = NARROW.matches ? "lists" : "tasks";
  render();
  if (want && items.has(want)) {
    const t = items.get(want);
    view = t.listId && items.has(t.listId) && t.listId !== "inbox" ? t.listId : "inbox";
    app.dataset.view = "tasks";
    openDetail(want); render();
    history.replaceState(null, "", location.pathname);
  }

  if (sync.configured) {
    const back = await sync.start({
      allowRedirect: true,
      onStatus: syncUI.render,
      onRedirect: flushSaves,
      onPulled: ids => { reload(ids); announce(ids, windowId); },
    });
    if (back && back.purpose === "import") {
      if (back.ok) runImport();
      else if (back.error !== "access_denied") toast("Microsoft sign-in didn't finish, so nothing was imported.");
    }
  }
}
init();

if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  navigator.serviceWorker.register("sw.js").catch(err => console.warn("Offline support unavailable:", err));
}
