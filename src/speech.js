// Speech in and out for iPhone Safari (Web Speech API).
// Recognition runs one language at a time; the app decides whose turn it is.

const SR = typeof window !== "undefined"
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

export const recognitionSupported = !!SR;

/**
 * One microphone session at a time. Built around two iPhone quirks:
 *  - iOS sends late "end"/"aborted" events from an old session after a new one
 *    has started, so every callback checks it still belongs to the current session.
 *  - iOS needs a moment to release the mic before it can start again.
 *  - iOS often ends without ever marking a result final, so whatever was heard
 *    last is used when the session ends.
 */
export class Listener {
  constructor() {
    this.rec = null;
    this.lastStop = 0;
    this.finishCurrent = null;
  }

  start(lang, { onStart, onInterim, onResult, onSilence, onError } = {}) {
    this.stop();
    if (!SR) { onError?.("unsupported"); return; }

    const rec = new SR();
    this.rec = rec;
    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    let latest = "";
    let settled = false;
    const isCurrent = () => this.rec === rec;

    const release = () => {
      if (this.rec === rec) {
        this.rec = null;
        this.lastStop = Date.now();
        this.finishCurrent = null;
      }
    };

    const deliver = () => {
      if (settled) return;
      settled = true;
      const text = latest.trim();
      release();
      try { rec.abort(); } catch { /* already stopped */ }
      if (text) onResult?.(text); else onSilence?.();
    };
    this.finishCurrent = deliver;

    rec.onstart = () => { if (isCurrent()) onStart?.(); };
    rec.onresult = (e) => {
      if (!isCurrent()) return;
      latest = Array.from(e.results).map(r => r[0].transcript).join("");
      onInterim?.(latest);
      if (e.results[e.results.length - 1].isFinal) deliver();
    };
    rec.onerror = (e) => {
      if (!isCurrent()) return;
      if (e.error === "no-speech" || e.error === "aborted") { deliver(); return; }
      settled = true;
      release();
      onError?.(e.error);
    };
    rec.onend = () => { if (isCurrent()) deliver(); };

    const begin = () => {
      if (!isCurrent()) return;
      try { rec.start(); } catch { settled = true; release(); onError?.("busy"); }
    };
    if (Date.now() - this.lastStop < 800) setTimeout(begin, 350); else begin();
  }

  /** Stop now and use whatever has been heard so far ("I've finished talking"). */
  finish() { this.finishCurrent?.(); }

  /** Stop and throw away anything heard. */
  stop() {
    const rec = this.rec;
    if (!rec) return;
    this.rec = null;
    this.finishCurrent = null;
    this.lastStop = Date.now();
    try { rec.abort(); } catch { /* ignore */ }
  }

  get active() { return this.rec !== null; }
}

// ── Speaking ────────────────────────────────────────────────────────────

let speechToken = 0;

function pickVoice(lang) {
  const synth = window.speechSynthesis;
  const voices = synth?.getVoices?.() || [];
  const norm = v => (v.lang || "").replace("_", "-");
  const better = v => /enhanced|premium|增强|高品质/i.test(v.name);
  const fallbacks = lang.startsWith("zh") ? [lang, "zh-CN", "zh"] : [lang, "en-GB", "en"];
  for (const prefix of fallbacks) {
    const matches = voices.filter(v => norm(v).startsWith(prefix));
    if (matches.length) return matches.find(better) || matches[0];
  }
  return null;
}

/** iOS only lets a page speak after a tap has spoken once. Call from a tap. */
export function unlockSpeech() {
  const synth = window.speechSynthesis;
  if (!synth) return;
  try {
    const u = new SpeechSynthesisUtterance(" ");
    u.volume = 0;
    synth.speak(u);
  } catch { /* ignore */ }
}

export function stopSpeaking() {
  speechToken++;
  try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
}

/**
 * Speak text and call onEnd once it has really finished. iOS sometimes never
 * fires "end", so a generous timer backs it up, and the mic is only handed back
 * once the synthesiser reports it is silent (otherwise the phone would hear
 * and translate its own voice).
 */
export function speak(text, lang, { rate = 0.92, onEnd } = {}) {
  const synth = window.speechSynthesis;
  const token = ++speechToken;
  if (!synth || !text) { onEnd?.(); return; }
  try { synth.cancel(); } catch { /* ignore */ }

  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = lang;
  utt.rate = rate;
  const voice = pickVoice(lang);
  if (voice) utt.voice = voice;

  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    if (token !== speechToken) return; // cancelled or replaced
    let waited = 0;
    const waitForSilence = () => {
      if (token !== speechToken) return;
      if (synth.speaking && waited < 10000) { waited += 250; setTimeout(waitForSilence, 250); return; }
      setTimeout(() => { if (token === speechToken) onEnd?.(); }, 300);
    };
    waitForSilence();
  };
  const perChar = lang.startsWith("zh") ? 320 : 95;
  const timer = setTimeout(finish, 3000 + (text.length * perChar) / rate);
  utt.onend = finish;
  utt.onerror = finish;
  synth.speak(utt);
}
