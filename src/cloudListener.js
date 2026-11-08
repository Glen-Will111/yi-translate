// Hands-free listening for OpenAI transcription.
//
// The mic stays open for the whole conversation. A simple voice detector
// notices when someone starts talking, records until they pause, and hands
// over that phrase as a small WAV file. Nothing is sent while nobody is talking,
// so you only pay for speech, and the detector is switched off ("gated") while
// the phone itself is speaking so it never transcribes its own voice.

const AC = typeof window !== "undefined" ? (window.AudioContext || window.webkitAudioContext) : null;

export const cloudCaptureSupported = !!(AC && typeof navigator !== "undefined" && navigator.mediaDevices?.getUserMedia);

const FRAME = 4096;          // samples per analysis frame (~85 ms at 48 kHz)
const PREROLL_MS = 400;      // keep this much audio from just before speech starts
const MIN_SPEECH_MS = 350;   // shorter than this is a cough or a bump: ignore
const MAX_PHRASE_MS = 28000; // cut very long phrases so each request stays small
const TARGET_RATE = 16000;   // what speech recognisers want

export const SENSITIVITY = { low: 0.022, normal: 0.012, high: 0.006 };
export const PAUSE_MS = { short: 800, normal: 1200, long: 1900 };

export class CloudListener {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.proc = null;
    this.running = false;
    this.gated = false;
    this.ungateAt = 0;
    this.minLevel = SENSITIVITY.normal;
    this.pauseMs = PAUSE_MS.normal;
    this.handlers = {};
    this.resetDetector();
  }

  resetDetector() {
    this.inSpeech = false;
    this.preroll = [];
    this.phrase = [];
    this.loudFrames = 0;
    this.voicedMs = 0;
    this.silentMs = 0;
    this.floor = this.floor ?? 0.003;
  }

  configure({ sensitivity, pause } = {}) {
    if (sensitivity && SENSITIVITY[sensitivity]) this.minLevel = SENSITIVITY[sensitivity];
    if (pause && PAUSE_MS[pause]) this.pauseMs = PAUSE_MS[pause];
  }

  /**
   * Open the mic. Must be called straight from a tap: iOS only allows audio to
   * start inside a user gesture, so the AudioContext is created and resumed
   * before anything is awaited.
   */
  async open() {
    if (!cloudCaptureSupported) throw new Error("This browser can't record audio.");
    const live = this.stream?.getAudioTracks().some(t => t.readyState === "live");
    if (this.ctx && live) {
      if (this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
      return;
    }
    if (this.ctx || this.stream) this.close(); // iOS ended the mic (e.g. phone locked): start afresh
    try { if (navigator.audioSession) navigator.audioSession.type = "play-and-record"; } catch { /* Safari 16.4+ only */ }
    const ctx = this.ctx || new AC();
    this.ctx = ctx;
    const resumed = ctx.resume().catch(() => {});

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const e = new Error(err?.name === "NotAllowedError" ? "not-allowed" : (err?.message || "mic-failed"));
      throw e;
    }
    await resumed;
    this.stream = stream;

    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(FRAME, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(proc);
    proc.connect(mute);
    mute.connect(ctx.destination); // processor only runs when connected; muted so nothing is heard
    proc.onaudioprocess = e => this.onFrame(e.inputBuffer.getChannelData(0));
    this.proc = proc;
    this.source = source;
    this.mute = mute;
  }

  get isOpen() { return !!(this.ctx && this.stream); }
  get hearingVoice() { return this.inSpeech; }
  get audioRunning() { return this.ctx?.state === "running"; }

  /** Start listening. handlers: onLevel(0..1), onVoiceStart(), onPhrase(wavBlob, ms), onNoise() */
  start(handlers = {}) {
    this.handlers = handlers;
    this.resetDetector();
    this.running = true;
  }

  /** Stop listening but keep the mic open (quick to restart). */
  pause() { this.running = false; this.resetDetector(); this.handlers.onLevel?.(0); }

  /** Ignore the mic while the phone speaks; resume shortly after. */
  setGated(gated) {
    if (gated) {
      this.gated = true;
      this.resetDetector();
      this.handlers.onLevel?.(0);
    } else {
      this.gated = false;
      this.ungateAt = Date.now() + 450; // let the room echo die away
    }
  }

  /** "I've finished talking": send what has been heard so far. */
  finishNow() { if (this.inSpeech) this.endPhrase(); }

  close() {
    this.running = false;
    try { this.proc && (this.proc.onaudioprocess = null); } catch { /* ignore */ }
    try { this.source?.disconnect(); this.proc?.disconnect(); this.mute?.disconnect(); } catch { /* ignore */ }
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.proc = null;
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
  }

  onFrame(input) {
    if (!this.running || this.gated || Date.now() < this.ungateAt) return;
    const frame = new Float32Array(input); // the browser reuses its buffer
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    const rms = Math.sqrt(sum / frame.length);
    const frameMs = (frame.length / this.ctx.sampleRate) * 1000;
    const threshold = Math.max(this.minLevel, this.floor * 3);
    this.handlers.onLevel?.(Math.min(1, rms / (threshold * 4)));

    if (!this.inSpeech) {
      if (rms < threshold) this.floor = this.floor * 0.95 + rms * 0.05; // learn the room's background noise
      this.preroll.push(frame);
      const keep = Math.ceil(PREROLL_MS / frameMs);
      if (this.preroll.length > keep) this.preroll.shift();
      this.loudFrames = rms > threshold ? this.loudFrames + 1 : 0;
      if (this.loudFrames >= 2) {
        this.inSpeech = true;
        this.phrase = [...this.preroll];
        this.preroll = [];
        this.voicedMs = this.loudFrames * frameMs;
        this.silentMs = 0;
        this.handlers.onVoiceStart?.();
      }
      return;
    }

    this.phrase.push(frame);
    if (rms > threshold * 0.7) { this.silentMs = 0; this.voicedMs += frameMs; }
    else this.silentMs += frameMs;
    const lengthMs = this.phrase.length * frameMs;
    if (this.silentMs >= this.pauseMs || lengthMs >= MAX_PHRASE_MS) this.endPhrase();
  }

  endPhrase() {
    const frames = this.phrase;
    const voicedMs = this.voicedMs;
    const rate = this.ctx?.sampleRate || 48000;
    this.resetDetector();
    if (voicedMs < MIN_SPEECH_MS || !frames.length) { this.handlers.onNoise?.(); return; }
    // Trim most of the trailing silence, keeping a little so the last word isn't clipped.
    const frameMs = (FRAME / rate) * 1000;
    const trimFrames = Math.max(0, Math.floor((this.pauseMs - 300) / frameMs));
    const kept = frames.slice(0, Math.max(1, frames.length - trimFrames));
    const wav = encodeWav(kept, rate, TARGET_RATE);
    this.handlers.onPhrase?.(wav, Math.round(kept.length * frameMs));
  }
}

/** Join Float32 frames, resample to 16 kHz mono and wrap as a 16-bit WAV file. */
export function encodeWav(frames, inRate, outRate = TARGET_RATE) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const joined = new Float32Array(total);
  let o = 0;
  for (const f of frames) { joined.set(f, o); o += f.length; }

  const ratio = inRate / outRate;
  const outLen = Math.max(1, Math.floor(total / ratio));
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    // average the input samples that fall into this output sample (simple low-pass)
    const start = Math.floor(i * ratio);
    const end = Math.min(total, Math.floor((i + 1) * ratio));
    let s = 0;
    for (let j = start; j < end; j++) s += joined[j];
    const v = end > start ? s / (end - start) : joined[start] || 0;
    pcm[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
  }

  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const dv = new DataView(buf);
  const str = (off, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); dv.setUint32(4, 36 + pcm.length * 2, true); str(8, "WAVE");
  str(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, outRate, true); dv.setUint32(28, outRate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  str(36, "data"); dv.setUint32(40, pcm.length * 2, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}
