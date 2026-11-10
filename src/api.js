import {
  MODEL, MAX_CHECK_ROUNDS, PINYIN_PROMPT,
  translateSystemPrompt, backTranslateSystemPrompt, compareSystemPrompt,
} from "./prompts.js";

const ENDPOINT = "/api/translate";

export async function callClaude({ system, user, maxTokens = 1200, passcode }) {
  const headers = { "Content-Type": "application/json" };
  if (passcode) headers["x-app-passcode"] = passcode;
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
  } catch {
    throw new Error("No connection. Check Wi-Fi or mobile data.");
  }
  if (res.status === 401) throw new Error("Passcode needed or wrong. Check ⚙ Settings.");
  if (!res.ok) throw new Error(`Translation service error (${res.status})`);
  const data = await res.json();
  return (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("")
    .trim();
}

/** Pull the JSON object out of a reply, tolerating stray text or code fences. */
export function parseJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { /* fall through */ }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

const str = v => (typeof v === "string" && v.trim() ? v.trim() : null);

function historyBlock(history, names) {
  if (!history.length) return "";
  const lines = history.map(e => {
    const who = names[e.speaker] || e.speaker;
    return `${who}: ${e.source}  →  ${e.translated}`;
  });
  return `RECENT CONVERSATION (context only, do not translate):\n${lines.join("\n")}\n\n`;
}

/**
 * Step 1: understand and translate what was said.
 * side = who spoke: "en" (English speaker) or "zh" (Chongqing / Mandarin speaker).
 */
export async function translateUtterance({ text, side, settings, history = [] }) {
  const { names } = settings;
  const speakerDesc = side === "en"
    ? `${names.en} (English)`
    : `${names.zh} (Chongqing dialect and/or Mandarin)`;
  const user = `${historyBlock(history, names)}SPEAKER: ${speakerDesc}
TRANSLATE INTO: ${side === "en" ? "Mandarin Chinese" : "English"}
TRANSCRIPT: ${text}`;

  const raw = await callClaude({
    system: translateSystemPrompt(settings),
    user,
    maxTokens: 1500,
    passcode: settings.passcode,
  });
  const j = parseJson(raw);
  if (!j || !str(j.translation)) {
    // A bare translation with no JSON is still usable; anything else is an error.
    if (raw && !raw.includes("{")) {
      return { garbled: false, heardAs: text, mandarin: null, translation: raw, tone: null, notes: [], notesZh: [], check: null, checkZh: null, ask: null };
    }
    throw new Error("Couldn't read the translation. Tap Retry.");
  }
  return {
    garbled: j.garbled === true,
    heardAs: str(j.heard_as) || text,
    mandarin: side === "zh" ? str(j.mandarin) : null,
    translation: str(j.translation),
    tone: str(j.tone),
    notes: Array.isArray(j.notes) ? j.notes.map(str).filter(Boolean) : [],
    notesZh: Array.isArray(j.notes_zh) ? j.notes_zh.map(str).filter(Boolean) : [],
    check: str(j.check),
    checkZh: str(j.check_zh),
    ask: side === "zh" ? str(j.ask) : null,
  };
}

/**
 * Steps 2 to 4: blind back-translation, comparison against the source, and a
 * targeted fix if the meaning drifted, repeated up to MAX_CHECK_ROUNDS.
 * Returns the translation to speak plus a status:
 *   pass      checked first time
 *   fixed     a drift was found and corrected, and the correction checked out
 *   fail      still not right after the last round (spoken with a warning)
 *   unchecked the check itself could not be completed
 */
export async function verifyTranslation({ source, translation, side, settings }) {
  const sourceLang = side === "en" ? "English" : "Mandarin Chinese";
  const targetLang = side === "en" ? "Mandarin Chinese" : "English";
  let current = translation;
  let issue = null;
  let back = null;

  for (let round = 1; round <= MAX_CHECK_ROUNDS; round++) {
    back = await callClaude({
      system: backTranslateSystemPrompt(sourceLang),
      user: current,
      maxTokens: 800,
      passcode: settings.passcode,
    });
    const verdict = parseJson(await callClaude({
      system: compareSystemPrompt(settings),
      user: `SOURCE (${sourceLang}):\n${source}\n\nTRANSLATION (${targetLang}):\n${current}\n\nBACK-TRANSLATION (${sourceLang}):\n${back}`,
      maxTokens: 800,
      passcode: settings.passcode,
    }));

    if (!verdict || typeof verdict.accurate !== "boolean") {
      return { translation: current, status: "unchecked", issue: "The accuracy check couldn't be completed.", back, rounds: round };
    }
    if (verdict.accurate) {
      return { translation: current, status: round === 1 ? "pass" : "fixed", issue, back, rounds: round };
    }
    issue = str(verdict.issue) || "The meaning drifted.";
    const corrected = str(verdict.corrected);
    if (!corrected || corrected === current) {
      return { translation: current, status: "fail", issue, back, rounds: round };
    }
    current = corrected;
  }
  return { translation: current, status: "fail", issue, back, rounds: MAX_CHECK_ROUNDS };
}

export async function fetchPinyin(chinese, settings) {
  return callClaude({ system: PINYIN_PROMPT, user: chinese, maxTokens: 800, passcode: settings.passcode });
}

// ── OpenAI hearing ────────────────────────────────────────────────────────

const TRANSCRIBE_ENDPOINT = "/api/transcribe";

/** Is OpenAI hearing set up on the server (OPENAI_API_KEY present)? */
export async function cloudHearingAvailable() {
  try {
    const res = await fetch(TRANSCRIBE_ENDPOINT, { method: "GET" });
    if (!res.ok) return false;
    const data = await res.json();
    return data.enabled === true;
  } catch { return false; }
}

export function transcriptionPrompt(names) {
  return `${names.en} and ${names.zh}, a couple, chatting at home. ${names.en} speaks Australian English. ${names.zh} is from Chongqing and speaks Mandarin, sometimes with Chongqing dialect words. 中文请用简体字。`;
}

export async function transcribeAudio(blob, settings) {
  const form = new FormData();
  form.append("file", blob, "speech.wav");
  form.append("prompt", transcriptionPrompt(settings.names));
  const headers = {};
  if (settings.passcode) headers["x-app-passcode"] = settings.passcode;
  let res;
  try {
    res = await fetch(TRANSCRIBE_ENDPOINT, { method: "POST", headers, body: form });
  } catch {
    throw new Error("No connection. Check Wi-Fi or mobile data.");
  }
  if (res.status === 401) throw new Error("Passcode needed or wrong. Check ⚙ Settings.");
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Hearing service error (${res.status})${data.error ? `: ${data.error}` : ""}`);
  return (data.text || "").trim();
}

const HAN = /[\u3400-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD = /[A-Za-z]+(?:'[A-Za-z]+)?/g;

/** Who spoke, judged by the language of the words: Chinese → zh side, otherwise en. */
export function detectSide(text) {
  const han = (text.match(HAN) || []).length;
  const latin = (text.match(LATIN_WORD) || []).length;
  if (!han) return "en";
  if (!latin) return "zh";
  return han >= latin * 1.5 ? "zh" : "en";
}

// Phrases speech models are known to invent from silence or background noise.
const PHANTOMS = [
  /^(thank you|thanks) (so much )?for watching[.!]*$/i,
  /subtitles? (by|from|created)/i,
  /amara\.org/i,
  /字幕/,
  /(点赞|订阅).*(订阅|转发|打赏)/,
  /^(谢谢|感谢)(大家)?(观看|收看)[。！!]*$/,
];

/** Drop empty results, invented "phantom" phrases and echoes of the prompt. */
export function isPhantom(text, names) {
  const t = (text || "").trim();
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return true;
  if (PHANTOMS.some(re => re.test(t))) return true;
  const prompt = transcriptionPrompt(names);
  return t.length > 12 && prompt.includes(t);
}
