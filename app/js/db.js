// On-device storage for InkTasks (IndexedDB "inktasks"). Also loaded by InkNotes for "Make task",
// which works because both apps live on the same website.
//
// items: lists and tasks, one record each.
//   list: { id, kind: "list", name, order, created, updated, deleted }
//         The default list has id "inbox" and is made on each device (welcome: true keeps it
//         local until renamed).
//   task: { id, kind: "task", listId, title, done, doneAt, important, myDay ("YYYY-MM-DD" | null),
//           due ("YYYY-MM-DD" | null), repeat ({ unit: day|week|month|year, every, days? } | null),
//           remind (local "YYYY-MM-DDTHH:MM" | null), notes, steps: [{ id, title, done }],
//           order, noteId?, noteTitle?, msId?, created, updated, deleted }

const DB_NAME = "inktasks", DB_VERSION = 1;
let dbPromise = null, memory = null;
export const hooks = { onBlocked() {}, onUnblocked() {}, onVersionChange() {} };

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (err) { reject(err); return; }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains("items")) req.result.createObjectStore("items", { keyPath: "id" });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; hooks.onVersionChange(); };
      hooks.onUnblocked();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => hooks.onBlocked();
  }).catch(err => {
    console.warn("InkTasks: on-device storage unavailable; tasks last only this session.", err);
    memory = new Map();
    return null;
  });
  return dbPromise;
}

function run(mode, fn, memFn) {
  return open().then(db => {
    if (!db) return memFn(memory);
    return new Promise((resolve, reject) => {
      const tx = db.transaction("items", mode);
      const req = fn(tx.objectStore("items"));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  });
}
const clone = o => JSON.parse(JSON.stringify(o));

export const db = {
  all: () => run("readonly", s => s.getAll(), m => [...m.values()].map(clone)),
  get: id => run("readonly", s => s.get(id), m => (m.has(id) ? clone(m.get(id)) : undefined)),
  put: item => { const c = clone(item); return run("readwrite", s => s.put(c), m => { m.set(c.id, c); }); },
  putMany: items => run("readwrite", s => { let last; for (const i of items) last = s.put(clone(i)); return last; },
    m => { for (const i of items) m.set(i.id, clone(i)); }),
  get persistent() { return !memory; },
};

// Tell open InkTasks windows that items changed (from InkNotes, another window, or sync).
export function announce(ids, from = "") {
  if (!("BroadcastChannel" in self)) return;
  const ch = new BroadcastChannel("inktasks");
  ch.postMessage({ type: "changed", ids, from });
  ch.close();
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export function newTask(fields = {}) {
  const now = Date.now();
  return {
    id: newId(), kind: "task", listId: "inbox", title: "", done: false, doneAt: null, important: false,
    myDay: null, due: null, repeat: null, remind: null, notes: "", steps: [], order: -now,
    created: now, updated: now, deleted: false, ...fields,
  };
}
