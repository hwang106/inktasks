// Web Push with only WebCrypto (runs on Cloudflare Workers and in Node for tests).
//   - Payload encryption: RFC 8291 (aes128gcm), so the push service (Google for Chrome,
//     Microsoft for Edge) can't read what it carries.
//   - Sender identity: VAPID (RFC 8292), an ES256-signed token.

const te = new TextEncoder();
export const b64u = u8 => btoa(String.fromCharCode(...new Uint8Array(u8))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bytes * 8));
}

// Encrypts `payload` (Uint8Array) for one subscription { keys: { p256dh, auth } }.
// `_test` lets tests pin the sender key and salt.
export async function encryptPayload(subscription, payload, _test = {}) {
  const uaPublic = unb64u(subscription.keys.p256dh);
  const authSecret = unb64u(subscription.keys.auth);
  const asKeys = _test.asKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdh, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = _test.salt || crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ct);
}

// VAPID keys: { publicKey: base64url raw P-256 point, privateJwk: JWK }.
export async function vapidHeaders(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(head + "." + body)));
  return { Authorization: `vapid t=${head}.${body}.${b64u(sig)}, k=${vapid.publicKey}` };
}

// Sends one push. Returns the push service's status (201 = accepted; 404/410 = subscription gone).
export async function sendPush(subscription, payloadObj, vapid, subject, fetchImpl = fetch) {
  const body = await encryptPayload(subscription, te.encode(JSON.stringify(payloadObj)));
  const res = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      ...(await vapidHeaders(subscription.endpoint, vapid, subject)),
      "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
      TTL: "86400", Urgency: "high",
    },
    body,
  });
  return res.status;
}
