// Speech-to-text through OpenAI, so the key never reaches the phone.
//
// Environment variables (Netlify → Site configuration → Environment variables):
//   OPENAI_API_KEY            required for OpenAI hearing (without it the app
//                             falls back to the iPhone's own speech recognition)
//   OPENAI_TRANSCRIBE_MODEL   optional, defaults to gpt-4o-transcribe
//   APP_PASSCODE              optional, same passcode as the translate function
//
// GET  /api/transcribe  → { enabled: true|false }   (lets the app pick a hearing mode)
// POST /api/transcribe  multipart form: file (audio), prompt (optional) → { text }

const MAX_BYTES = 5 * 1024 * 1024;

export default async (request) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-app-passcode",
    "Content-Type": "application/json",
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method === "GET") return json({ enabled: !!process.env.OPENAI_API_KEY });
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const required = process.env.APP_PASSCODE;
  if (required && request.headers.get("x-app-passcode") !== required) {
    return json({ error: "Passcode required" }, 401);
  }
  if (!process.env.OPENAI_API_KEY) return json({ error: "OPENAI_API_KEY is not set in Netlify" }, 503);

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return json({ error: "No audio received" }, 400);
    if (file.size > MAX_BYTES) return json({ error: "Audio too long" }, 413);

    const out = new FormData();
    out.append("file", file, file.name || "speech.wav");
    out.append("model", process.env.OPENAI_TRANSCRIBE_MODEL || "gpt-4o-transcribe");
    out.append("response_format", "json");
    const prompt = form.get("prompt");
    if (typeof prompt === "string" && prompt.trim()) out.append("prompt", prompt.slice(0, 800));
    // No "language" field: the model detects English or Chinese by itself.

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: out,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return json({ error: data?.error?.message || "Transcription failed" }, response.status);
    return json({ text: (data.text || "").trim() });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
};

export const config = {
  path: "/api/transcribe",
};
