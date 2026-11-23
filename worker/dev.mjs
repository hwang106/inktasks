// Runs the reminder service on this computer for testing with the InkNotes dev server's pretend
// Microsoft:  node dev.mjs   (then, in InkNotes: node dev-server.js --fake-ms --port=5174)
// SQLite stands in for D1; due reminders are checked every 5 seconds. VAPID keys for testing are
// kept in .dev/vapid.json, which the dev server reads to point InkTasks here.
import http from "node:http";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { sendDue } from "./src/index.js";
import { b64u } from "./src/webpush.js";

const PORT = Number((process.argv.find(a => a.startsWith("--port=")) || "--port=8787").split("=")[1]);
const keysFile = new URL("./.dev/vapid.json", import.meta.url);
if (!existsSync(keysFile)) {
  const k = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  writeFileSync(keysFile, JSON.stringify({ publicKey: b64u(await crypto.subtle.exportKey("raw", k.publicKey)), privateJwk: await crypto.subtle.exportKey("jwk", k.privateKey) }, null, 2));
}
const keys = JSON.parse(readFileSync(keysFile, "utf8"));

const sqlite = new DatabaseSync(fileURLToPath(new URL("./.dev/reminders.db", import.meta.url)));
sqlite.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  first: async () => sqlite.prepare(sql).get(...args) ?? null,
  all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  run: async () => sqlite.prepare(sql).run(...args),
});
const env = {
  DB: { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); } },
  VAPID_PUBLIC: keys.publicKey, VAPID_PRIVATE_JWK: JSON.stringify(keys.privateJwk),
  ALLOWED_ORIGINS: "http://localhost:5173,http://localhost:5174", GRAPH: "http://localhost:5174/__fake/graph/v1.0",
};

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }), env);
  console.log(req.method, req.url, r.status);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(PORT, () => console.log(`Reminder service on http://localhost:${PORT}`));

setInterval(async () => {
  const r = await sendDue(env).catch(err => (console.warn(err), { sent: 0 }));
  if (r.sent) console.log("pushed", r.sent);
}, 5000);
