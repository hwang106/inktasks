// Runs the reminder service against a local SQLite database (standing in for Cloudflare D1), a
// pretend Microsoft Graph and a pretend push service that decrypts what it receives like a
// browser would (RFC 8291) and checks the VAPID signature (RFC 8292).
// Run: node test/worker.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { sendDue } from "../src/index.js";
import { b64u, unb64u } from "../src/webpush.js";

// ---------- D1 stand-in ----------
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => db.prepare(sql).run(...args),
  });
  return { prepare: sql => stmt(sql), batch: async list => { for (const s of list) await s.run(); }, raw: db };
}

// ---------- keys ----------
const vapidKeys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const VAPID_PUBLIC = b64u(await crypto.subtle.exportKey("raw", vapidKeys.publicKey));
const env = {
  DB: d1(), VAPID_PUBLIC, VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey("jwk", vapidKeys.privateKey)),
  ALLOWED_ORIGINS: "https://hwang106.github.io", GRAPH: "https://graph.test",
};

// A pretend browser subscription with its own keys, so the test can decrypt.
async function browser(name) {
  const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint: `https://push.test/${name}`, keys: { p256dh: b64u(await crypto.subtle.exportKey("raw", keys.publicKey)), auth: b64u(auth) } };
  return { sub, keys, auth };
}

async function hkdf(salt, ikm, info, n) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, n * 8));
}
// Receiver side of RFC 8291, written out separately from the sender.
async function decrypt(b, body) {
  const salt = body.slice(0, 16), rs = new DataView(body.buffer, body.byteOffset).getUint32(16), idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen), ct = body.slice(21 + idlen);
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, b.keys.privateKey, 256));
  const uaPublic = unb64u(b.sub.keys.p256dh);
  const info = new Uint8Array([...new TextEncoder().encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(b.auth, ecdh, info, 32);
  const cek = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, new TextEncoder().encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ct));
  assert.equal(pt[pt.length - 1], 2, "last-record padding delimiter");
  return JSON.parse(new TextDecoder().decode(pt.slice(0, -1)));
}
async function verifyVapid(header, endpoint) {
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.ok(m, "vapid header shape");
  assert.equal(m[4], VAPID_PUBLIC);
  const claims = JSON.parse(new TextDecoder().decode(unb64u(m[2])));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 24 * 3600);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, vapidKeys.publicKey, unb64u(m[3]), new TextEncoder().encode(m[1] + "." + m[2]));
  assert.ok(ok, "vapid signature verifies");
}

// ---------- pretend network ----------
let owner = "user-A";
const pushes = [];
let goneEndpoints = new Set();
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("https://graph.test/me/drive/special/approot")) {
    return opts.headers.Authorization === "Bearer good-token"
      ? new Response(JSON.stringify({ id: "approot", parentReference: { driveId: owner, driveType: "personal" } }), { status: 200 })
      : new Response("{}", { status: 401 });
  }
  if (url.startsWith("https://push.test/")) {
    if (goneEndpoints.has(url)) return new Response("", { status: 410 });
    pushes.push({ url, headers: opts.headers, body: new Uint8Array(opts.body) });
    return new Response("", { status: 201 });
  }
  throw new Error("unexpected fetch " + url);
};
const call = (path, body, headers = {}) => worker.fetch(new Request("https://svc.test" + path, {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", Origin: "https://hwang106.github.io", ...headers },
}), env);

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok -", name); }

const phone = await browser("phone"), surface = await browser("surface");
let phoneDev, surfaceDev;

await test("register needs a real Microsoft sign-in", async () => {
  const r = await call("/register", { subscription: phone.sub, msToken: "bad" });
  assert.equal(r.status, 401);
});
await test("first device claims the service; CORS only for the app's site", async () => {
  const r = await call("/register", { subscription: phone.sub, msToken: "good-token" });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("Access-Control-Allow-Origin"), "https://hwang106.github.io");
  phoneDev = await r.json();
  assert.match(phoneDev.device, /^[0-9a-f]{32}$/);
  const s = await call("/register", { subscription: surface.sub, msToken: "good-token" });
  surfaceDev = await s.json();
  const stored = env.DB.raw.prepare("SELECT token_hash FROM devices").all().map(r => r.token_hash);
  assert.ok(!stored.includes(phoneDev.token), "tokens are stored hashed");
  const other = await worker.fetch(new Request("https://svc.test/health", { headers: { Origin: "https://evil.test" } }), env);
  assert.equal(other.headers.get("Access-Control-Allow-Origin"), null);
});
await test("another Microsoft account can't register", async () => {
  owner = "user-B";
  const r = await call("/register", { subscription: (await browser("x")).sub, msToken: "good-token" });
  assert.equal(r.status, 403);
  owner = "user-A";
});
const auth = d => ({ Authorization: `Device ${d.device}:${d.token}` });
await test("reminders need a device token", async () => {
  assert.equal((await call("/reminders", { items: [] })).status, 401);
  assert.equal((await call("/reminders", { items: [] }, { Authorization: `Device ${phoneDev.device}:${"0".repeat(64)}` })).status, 401);
});

const now = Date.now();
await test("a due reminder is pushed, encrypted, to every device, once", async () => {
  await call("/reminders", { items: [
    { id: "t1", at: now - 1000, updated: 1, payload: "SEALED-1" },
    { id: "t2", at: now + 3600e3, updated: 1, payload: "SEALED-2" },
  ] }, auth(phoneDev));
  const r = await sendDue(env, now);
  assert.equal(r.sent, 2);
  assert.equal(pushes.length, 2);
  for (const p of pushes) {
    const b = p.url.endsWith("phone") ? phone : surface;
    await verifyVapid(p.headers.Authorization, p.url);
    assert.equal(p.headers["Content-Encoding"], "aes128gcm");
    const msg = await decrypt(b, p.body);
    assert.deepEqual(msg, { id: "t1", at: now - 1000, sealed: "SEALED-1" });
    assert.ok(!new TextDecoder().decode(p.body).includes("SEALED-1"), "payload is encrypted in transit");
  }
  assert.equal((await sendDue(env, now + 1000)).sent, 0, "not sent twice");
});
await test("moving a reminder re-arms it; older edits lose; clearing cancels", async () => {
  pushes.length = 0;
  await call("/reminders", { items: [{ id: "t1", at: now + 5000, updated: 2, payload: "SEALED-1b" }] }, auth(surfaceDev));
  await call("/reminders", { items: [{ id: "t1", at: now + 999999, updated: 1, payload: "OLD" }] }, auth(phoneDev));
  assert.equal((await sendDue(env, now + 6000)).sent, 2);
  assert.equal((await decrypt(phone, pushes[0].body)).sealed, "SEALED-1b");
  await call("/reminders", { items: [{ id: "t2", at: null, updated: 5 }] }, auth(phoneDev));
  pushes.length = 0;
  assert.equal((await sendDue(env, now + 7200e3)).sent, 0, "cleared reminder never fires");
});
await test("a browser that unsubscribed is dropped", async () => {
  goneEndpoints.add(surface.sub.endpoint);
  await call("/reminders", { items: [{ id: "t3", at: now, updated: 1, payload: "S3" }] }, auth(phoneDev));
  await sendDue(env, now + 1);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM devices").get().n, 1);
});
await test("a device without notifications can set reminders, and can switch them on later", async () => {
  const quiet = await (await call("/register", { subscription: null, msToken: "good-token" })).json();
  pushes.length = 0;
  await call("/reminders", { items: [{ id: "t4", at: now, updated: 1, payload: "S4" }] }, auth(quiet));
  assert.equal((await sendDue(env, now + 1)).sent, 1, "only the phone is notified");
  const laptop = await browser("laptop");
  const loud = await (await call("/register", { subscription: laptop.sub, msToken: "good-token", previous: quiet })).json();
  assert.equal((await call("/reminders", { items: [] }, auth(quiet))).status, 401, "old credentials replaced");
  assert.equal((await call("/reminders", { items: [] }, auth(loud))).status, 200);
});
await test("unregister removes the device", async () => {
  assert.equal((await call("/unregister", {}, auth(phoneDev))).status, 200);
  assert.equal((await call("/reminders", { items: [] }, auth(phoneDev))).status, 401);
});

console.log(`\n${passed} tests passed`);
