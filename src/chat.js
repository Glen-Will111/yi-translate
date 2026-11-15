// Talking to the chat storage (/api/chat) and setting up message alerts.

const ENDPOINT = "/api/chat";

export const normaliseCode = raw => String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
export const formatCode = code => (code ? `${code.slice(0, 5)}-${code.slice(5)}` : "");
export const looksLikeCode = raw => /^[2-9A-HJKMNP-Z]{10}$/.test(normaliseCode(raw));

class ChatError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(method, params, { body, headers } = {}) {
  const qs = new URLSearchParams(params).toString();
  let res;
  try {
    res = await fetch(`${ENDPOINT}?${qs}`, { method, headers, body, cache: "no-store" });
  } catch {
    throw new ChatError("No connection. Check Wi-Fi or mobile data.", 0);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ChatError(data.error || `Chat service error (${res.status})`, res.status);
  return data;
}

export async function createRoom(passcode) {
  const headers = passcode ? { "x-app-passcode": passcode } : undefined;
  const data = await request("POST", { op: "create" }, { headers });
  return data.room;
}

/** New messages since the phone last looked. Throws with status 404 if the code is wrong. */
export function fetchMessages(room, { token, since, full } = {}) {
  const params = { room };
  if (since) params.since = String(since);
  if (token) params.token = token;
  if (full) params.full = "1";
  return request("GET", params);
}

export function sendMessage(room, message) {
  return request("POST", { room, op: "send" }, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

export function uploadAudio(room, id, blob) {
  return request("POST", { room, op: "audio", id }, { headers: { "Content-Type": "audio/wav" }, body: blob });
}

export const audioUrl = (room, id) => `${ENDPOINT}?${new URLSearchParams({ room, audio: id })}`;

// ── Alerts (web push) ─────────────────────────────────────────────────────

const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isInstalled = () => window.navigator.standalone === true
  || window.matchMedia?.("(display-mode: standalone)").matches;

/**
 * Can this phone show alerts?
 *   "ok"            yes
 *   "needs-install" iPhone: only once the app is on the Home Screen
 *   "blocked"       alerts were refused; they have to be allowed in the phone's Settings
 *   "unsupported"   this browser can't
 */
export function alertSupport() {
  const capable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (!capable) return isIOS() && !isInstalled() ? "needs-install" : "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return "ok";
}

function keyBytes(base64url) {
  const b64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
function sameKey(buffer, bytes) {
  if (!buffer) return false;
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
}
const serviceWorkerReady = () => Promise.race([
  navigator.serviceWorker.ready,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Alerts aren't ready yet. Close the app, open it again and retry.")), 8000)),
]);

/**
 * Turn alerts on for this phone. Call straight from a tap: iPhones only show
 * the "Allow notifications?" question in answer to a tap.
 */
export async function enableAlerts(room, role) {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new ChatError("Alerts were not allowed.", 403);
  await syncAlerts(room, role);
}

/** Make sure the server has this phone's current alert address. Safe to repeat. */
export async function syncAlerts(room, role) {
  if (alertSupport() !== "ok" || Notification.permission !== "granted") return false;
  const reg = await serviceWorkerReady();
  const { publicKey } = await request("GET", { op: "pushkey" });
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await request("POST", { room, op: "subscribe" }, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role, subscription: sub.toJSON() }),
  });
  return true;
}

export async function disableAlerts(room, role) {
  try {
    const reg = await serviceWorkerReady();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await request("POST", { room, op: "unsubscribe" }, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role, endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* nothing to turn off */ }
}

/** Show the unread count on the app's Home Screen icon, where the phone supports it. */
export function setBadge(count) {
  try {
    if (count > 0) navigator.setAppBadge?.(count);
    else navigator.clearAppBadge?.();
  } catch { /* not supported */ }
}
