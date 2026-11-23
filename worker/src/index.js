// InkTasks reminder service (Cloudflare Worker + D1).
//
// Holds only: device push addresses, and per reminder an id, a time, and text sealed with the
// user's sync key (it can't read task titles). Every minute it pushes due reminders to all of the
// owner's devices. It belongs to one Microsoft account: the first device to register proves who
// that is (by reading which OneDrive their sign-in opens), and later devices must
// match.
//
// Routes (JSON):
//   POST /register   { subscription|null, msToken, previous? }  -> { device, token }
//                    (no subscription: a device that sets reminders but isn't notified itself;
//                     previous: { device, token } it replaces)
//   POST /reminders  { items: [{ id, at|null, updated, payload }] }   (Authorization: Device id:token)
//   POST /unregister                                     (Authorization: Device id:token)
//   GET  /health
// Env: DB (D1), VAPID_PUBLIC (base64url), VAPID_PRIVATE_JWK (secret, JSON), ALLOWED_ORIGINS
//      (comma-separated), GRAPH (optional; Microsoft Graph base, swapped in tests).

import { sendPush } from "./webpush.js";

const SUBJECT = "https://hwang106.github.io/inktasks/";
const MAX_ITEMS = 500;

const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))]
  .map(b => b.toString(16).padStart(2, "0")).join("");
const randomHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, "0")).join("");

function cors(req, env) {
  const origin = req.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return allowed.includes(origin) ? {
    "Access-Control-Allow-Origin": origin, "Vary": "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400",
  } : {};
}
const json = (obj, status, headers) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });

async function deviceFrom(req, env) {
  const m = /^Device ([0-9a-f]{32}):([0-9a-f]{64})$/.exec(req.headers.get("Authorization") || "");
  if (!m) return null;
  const row = await env.DB.prepare("SELECT id, token_hash FROM devices WHERE id = ?").bind(m[1]).first();
  return row && row.token_hash === await sha256(m[2]) ? row.id : null;
}

function validSubscription(s) {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && typeof s.keys.p256dh === "string" && typeof s.keys.auth === "string"
      && s.keys.p256dh.length < 200 && s.keys.auth.length < 100 && s.endpoint.length < 1000;
  } catch (_) { return false; }
}

async function register(req, env) {
  const { subscription = null, msToken, previous } = await req.json();
  if ((subscription !== null && !validSubscription(subscription)) || typeof msToken !== "string") return { status: 400, body: { error: "bad request" } };
  // Who is this? The OneDrive this Microsoft sign-in opens, read through the app folder (the only
  // OneDrive permission the apps hold). A personal OneDrive's id belongs to one account for good.
  const graph = env.GRAPH || "https://graph.microsoft.com/v1.0";
  const r = await fetch(`${graph}/me/drive/special/approot?$select=id,parentReference`, { headers: { Authorization: "Bearer " + msToken } });
  if (!r.ok) return { status: 401, body: { error: "Microsoft sign-in not accepted" } };
  const root = await r.json();
  const who = root && root.parentReference && root.parentReference.driveId;
  if (!who) return { status: 401, body: { error: "Couldn't identify the account" } };
  const owner = await env.DB.prepare("SELECT v FROM config WHERE k = 'owner'").first();
  if (!owner) await env.DB.prepare("INSERT INTO config (k, v) VALUES ('owner', ?)").bind(who).run();
  else if (owner.v !== who) return { status: 403, body: { error: "This reminder service belongs to another account" } };

  // One row per push address: re-registering the same browser replaces it, as does `previous`.
  if (subscription) await env.DB.prepare("DELETE FROM devices WHERE endpoint = ?").bind(subscription.endpoint).run();
  if (previous && /^[0-9a-f]{32}$/.test(previous.device) && typeof previous.token === "string") {
    await env.DB.prepare("DELETE FROM devices WHERE id = ? AND token_hash = ?").bind(previous.device, await sha256(previous.token)).run();
  }
  const id = randomHex(16), token = randomHex(32);
  await env.DB.prepare("INSERT INTO devices (id, token_hash, endpoint, sub, created) VALUES (?, ?, ?, ?, ?)")
    .bind(id, await sha256(token), subscription ? subscription.endpoint : null, subscription ? JSON.stringify(subscription) : null, Date.now()).run();
  return { status: 200, body: { device: id, token } };
}

async function upsertReminders(req, env) {
  const { items } = await req.json();
  if (!Array.isArray(items) || items.length > MAX_ITEMS) return { status: 400, body: { error: "bad request" } };
  const stmt = env.DB.prepare(`
    INSERT INTO reminders (id, at, updated, payload, sent) VALUES (?1, ?2, ?3, ?4, 0)
    ON CONFLICT(id) DO UPDATE SET
      sent = CASE WHEN excluded.at IS reminders.at THEN reminders.sent ELSE 0 END,
      at = excluded.at, updated = excluded.updated, payload = excluded.payload
    WHERE excluded.updated > reminders.updated`);
  const batch = [];
  for (const it of items) {
    if (typeof it.id !== "string" || it.id.length > 100 || typeof it.updated !== "number") continue;
    const at = typeof it.at === "number" ? it.at : null;
    const payload = typeof it.payload === "string" && it.payload.length < 3000 ? it.payload : null;
    batch.push(stmt.bind(it.id, at, it.updated, at === null ? null : payload));
  }
  if (batch.length) await env.DB.batch(batch);
  return { status: 200, body: { ok: true, count: batch.length } };
}

export async function sendDue(env, now = Date.now(), fetchImpl = fetch) {
  const due = (await env.DB.prepare(
    "SELECT id, at, payload FROM reminders WHERE sent = 0 AND at IS NOT NULL AND at <= ? ORDER BY at LIMIT 50").bind(now).all()).results;
  if (!due.length) return { sent: 0 };
  const devices = (await env.DB.prepare("SELECT id, sub FROM devices WHERE sub IS NOT NULL").all()).results;
  const vapid = { publicKey: env.VAPID_PUBLIC, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK) };
  let sent = 0;
  for (const r of due) {
    for (const d of devices) {
      try {
        const status = await sendPush(JSON.parse(d.sub), { id: r.id, at: r.at, sealed: r.payload }, vapid, SUBJECT, fetchImpl);
        if (status === 404 || status === 410) await env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(d.id).run();
        else if (status < 300) sent++;
      } catch (err) { console.warn("push failed", err); }
    }
    await env.DB.prepare("UPDATE reminders SET sent = 1 WHERE id = ? AND at = ?").bind(r.id, r.at).run();
  }
  // Tidy: reminders long past.
  await env.DB.prepare("DELETE FROM reminders WHERE (at IS NULL OR at < ?) AND updated < ?").bind(now - 30 * 864e5, now - 30 * 864e5).run();
  return { sent };
}

export default {
  async fetch(req, env) {
    const h = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const path = new URL(req.url).pathname;
    try {
      if (req.method === "GET" && path === "/health") return json({ ok: true }, 200, h);
      if (req.method !== "POST") return json({ error: "not found" }, 404, h);
      if (path === "/register") { const r = await register(req, env); return json(r.body, r.status, h); }
      const device = await deviceFrom(req, env);
      if (!device) return json({ error: "unknown device" }, 401, h);
      if (path === "/reminders") { const r = await upsertReminders(req, env); return json(r.body, r.status, h); }
      if (path === "/unregister") { await env.DB.prepare("DELETE FROM devices WHERE id = ?").bind(device).run(); return json({ ok: true }, 200, h); }
      return json({ error: "not found" }, 404, h);
    } catch (err) {
      console.warn(err);
      return json({ error: "server error" }, 500, h);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(sendDue(env));
  },
};
