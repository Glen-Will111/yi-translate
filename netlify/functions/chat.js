// Private two-person chat for when Glen and Lucy are apart.
//
// This function only stores and hands out messages. Each phone translates and
// checks its own message before sending it here, so no API keys are used.
// Messages live in Netlify Blobs (built into Netlify: no extra account).
//
// A chat is reached with a 10-character chat code that only the two phones
// know. Only a hash of the code is used in storage. Creating a chat needs the
// APP_PASSCODE (when one is set); everything else needs the chat code.
//
//   POST /api/chat?op=create                      → { room }
//   GET  /api/chat?room=CODE&token=T&since=MS     → { token, messages }
//   POST /api/chat?room=CODE&op=send              body: message JSON
//   POST /api/chat?room=CODE&op=audio&id=ID       body: WAV   (a voice message)
//   GET  /api/chat?room=CODE&audio=ID             → WAV
//   GET  /api/chat?op=pushkey                     → { publicKey }  (for alerts)
//   POST /api/chat?room=CODE&op=subscribe         body: { role, subscription }
//   POST /api/chat?room=CODE&op=unsubscribe       body: { role, endpoint }

import { createHash, randomBytes, randomInt } from "node:crypto";
import { getStore } from "@netlify/blobs";
import * as webpush from "web-push";

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O, 1/I/L: easy to read out and type
const CODE_RE = /^[2-9A-HJKMNP-Z]{10}$/;
const ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const MAX_MESSAGE_BYTES = 24 * 1024;
const MAX_AUDIO_BYTES = 3 * 1024 * 1024;
const OVERLAP_MS = 2 * 60 * 1000; // re-send recent messages so a late write is never missed
const HISTORY = 200;              // messages given to a phone joining or reopening

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, x-app-passcode",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

const pad = n => String(Math.max(0, Math.floor(n))).padStart(13, "0");
const hash = s => createHash("sha256").update(s).digest("hex").slice(0, 32);
const newToken = () => randomBytes(9).toString("base64url");
const other = role => (role === "en" ? "zh" : "en");

export function normaliseCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}
function newCode() {
  let s = "";
  for (let i = 0; i < 10; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return s;
}
function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

const text = (v, max = 4000) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const list = (v, max = 5) => (Array.isArray(v) ? v.map(x => text(x, 600)).filter(Boolean).slice(0, max) : []);
const side = v => (v === "en" || v === "zh" ? v : null);

/** Keep only the fields a message is allowed to have, with sensible limits. */
export function cleanMessage(m) {
  if (!m || typeof m !== "object") return null;
  const from = side(m.from);
  const source = text(m.source);
  const translated = text(m.translated);
  if (!ID_RE.test(m.id || "") || !from || !source || !translated) return null;
  return {
    id: m.id,
    from,
    fromName: text(m.fromName, 40),
    lang: side(m.lang) || from,
    source,
    heard: text(m.heard),
    mandarin: text(m.mandarin),
    translated,
    pinyin: text(m.pinyin),
    tone: text(m.tone, 60),
    notes: list(m.notes),
    notesZh: list(m.notesZh),
    check: text(m.check, 600),
    checkZh: text(m.checkZh, 600),
    verify: ["pass", "fixed", "fail", "unchecked"].includes(m.verify) ? m.verify : "unchecked",
    issue: text(m.issue, 600),
    back: text(m.back),
    audio: m.audio === true,
    typed: m.typed === true,
    time: text(m.time, 40),
  };
}

/** What the other person reads in the alert: the message in their language. */
export function alertText(msg) {
  const to = other(msg.from);
  const body = msg.lang === to ? (to === "zh" ? msg.mandarin || msg.source : msg.source) : msg.translated;
  const prefix = msg.audio ? "🎤 " : "";
  return (prefix + body).slice(0, 180);
}

async function vapidKeys(store) {
  let keys = await store.get("vapid", { type: "json" });
  if (keys?.publicKey && keys?.privateKey) return keys;
  // First use: make the key pair on the server and keep it there.
  await store.setJSON("vapid", webpush.generateVAPIDKeys(), { onlyIfNew: true });
  keys = await store.get("vapid", { type: "json" });
  return keys;
}

async function realSendPush(subscription, payload, vapid, subject) {
  await webpush.sendNotification(subscription, JSON.stringify(payload), {
    vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    TTL: 24 * 60 * 60,
    urgency: "high",
    timeout: 8000, // never let a slow alert service hold the message up
  });
}

async function notify({ store, base, msg, origin, sendPush }) {
  const to = other(msg.from);
  const { blobs } = await store.list({ prefix: `${base}s/${to}/` });
  if (!blobs.length) return;
  const vapid = await vapidKeys(store);
  const payload = {
    title: msg.fromName || (msg.from === "en" ? "Glen" : "Lucy"),
    body: alertText(msg),
    tag: msg.id,
    url: "/?tab=chat",
  };
  await Promise.allSettled(blobs.map(async b => {
    const sub = await store.get(b.key, { type: "json" });
    if (!sub?.endpoint) return;
    try {
      await sendPush(sub, payload, vapid, origin);
    } catch (err) {
      // The phone has turned alerts off or removed the app: forget it.
      if (err?.statusCode === 404 || err?.statusCode === 410) await store.delete(b.key);
      else console.error("push failed", err?.statusCode || err?.message);
    }
  }));
}

export async function handle(request, context, deps) {
  const { store, sendPush = realSendPush } = deps;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (request.method !== "GET" && request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = new URL(request.url);
  const q = url.searchParams;
  const op = q.get("op");

  try {
    if (request.method === "GET" && op === "pushkey") {
      return json({ publicKey: (await vapidKeys(store)).publicKey });
    }

    if (request.method === "POST" && op === "create") {
      const required = process.env.APP_PASSCODE;
      if (required && request.headers.get("x-app-passcode") !== required) return json({ error: "Passcode required" }, 401);
      const room = newCode();
      await store.setJSON(`r/${hash(room)}/head`, { token: newToken(), created: Date.now() });
      return json({ room });
    }

    // Everything below needs a valid chat code for a chat that exists.
    const room = normaliseCode(q.get("room"));
    if (!CODE_RE.test(room)) return json({ error: "Chat code not recognised" }, 404);
    const base = `r/${hash(room)}/`;
    const head = await store.get(`${base}head`, { type: "json" });
    if (!head) return json({ error: "Chat code not recognised" }, 404);

    if (request.method === "GET") {
      const audioId = q.get("audio");
      if (audioId) {
        if (!ID_RE.test(audioId)) return json({ error: "Not found" }, 404);
        const buf = await store.get(`${base}a/${audioId}`, { type: "arrayBuffer" });
        if (!buf) return json({ error: "Not found" }, 404);
        return audioResponse(buf, request.headers.get("range"));
      }

      // Poll for messages. If nothing has been posted since the phone last
      // looked (same token), answer straight away without listing anything.
      const since = Number(q.get("since")) || 0;
      if (q.get("token") === head.token && q.get("full") !== "1") {
        return json({ token: head.token, messages: [] });
      }
      const from = since ? Math.max(0, since - OVERLAP_MS) : 0;
      const prefix = `${base}m/${from ? commonPrefix(pad(from), pad(Date.now() + 60000)) : ""}`;
      const { blobs } = await store.list({ prefix });
      const floor = `${base}m/${pad(from)}`;
      let keys = blobs.map(b => b.key).filter(k => k >= floor).sort();
      keys = keys.slice(-HISTORY);
      const messages = (await Promise.all(keys.map(k => store.get(k, { type: "json" })))).filter(Boolean);
      return json({ token: head.token, messages });
    }

    // POST
    if (op === "send") {
      const raw = await request.text();
      if (raw.length > MAX_MESSAGE_BYTES) return json({ error: "Message too long" }, 413);
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { /* handled below */ }
      const msg = cleanMessage(parsed);
      if (!msg) return json({ error: "Message not understood" }, 400);
      msg.ts = Date.now();
      await store.setJSON(`${base}m/${pad(msg.ts)}-${msg.id}`, msg);
      await store.setJSON(`${base}head`, { ...head, token: newToken() });
      const alerting = notify({ store, base, msg, origin: url.origin, sendPush })
        .catch(err => console.error("notify failed", err?.message));
      if (context?.waitUntil) context.waitUntil(alerting); else await alerting;
      return json({ ok: true, ts: msg.ts });
    }

    if (op === "audio") {
      const id = q.get("id");
      if (!ID_RE.test(id || "")) return json({ error: "Bad id" }, 400);
      const buf = await request.arrayBuffer();
      if (!buf.byteLength) return json({ error: "No audio received" }, 400);
      if (buf.byteLength > MAX_AUDIO_BYTES) return json({ error: "Voice message too long" }, 413);
      await store.set(`${base}a/${id}`, buf);
      return json({ ok: true });
    }

    if (op === "subscribe" || op === "unsubscribe") {
      const body = await request.json().catch(() => null);
      const role = side(body?.role);
      const endpoint = op === "subscribe" ? body?.subscription?.endpoint : body?.endpoint;
      if (!role || typeof endpoint !== "string" || !/^https:\/\//.test(endpoint) || endpoint.length > 1000) {
        return json({ error: "Bad request" }, 400);
      }
      const key = `${base}s/${role}/${hash(endpoint)}`;
      if (op === "unsubscribe") { await store.delete(key); return json({ ok: true }); }
      const keys = body.subscription.keys;
      if (typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") return json({ error: "Bad request" }, 400);
      await store.setJSON(key, { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } });
      return json({ ok: true });
    }

    return json({ error: "Unknown request" }, 400);
  } catch (err) {
    console.error(err);
    return json({ error: err?.message || "Server error" }, 500);
  }
}

/** iPhones ask for audio in byte ranges, so answer those properly. */
function audioResponse(buf, range) {
  const total = buf.byteLength;
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "audio/wav",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=31536000, immutable",
  };
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${total}` } });
    }
    return new Response(buf.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(end - start + 1) },
    });
  }
  return new Response(buf, { status: 200, headers: { ...headers, "Content-Length": String(total) } });
}

export default (request, context) =>
  handle(request, context, { store: getStore({ name: "chat", consistency: "strong" }) });

export const config = {
  path: "/api/chat",
};
