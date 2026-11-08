import { useState, useRef, useEffect } from "react";
import {
  translateUtterance, verifyTranslation, fetchPinyin,
  cloudHearingAvailable, transcribeAudio, detectSide, isPhantom,
} from "./api.js";
import { DEFAULT_CONTEXT } from "./prompts.js";
import { Listener, recognitionSupported, speak, stopSpeaking, unlockSpeech } from "./speech.js";
import { CloudListener, cloudCaptureSupported } from "./cloudListener.js";
import { toText, toCsv, toHtml, deliverFile, exportFilename } from "./exporting.js";

const SETTINGS_KEY = "yi.settings.v2";
const CONVO_KEY = "yi.conversation.v2";

const DEFAULT_SETTINGS = {
  names: { en: "Glen", zh: "Lucy" },
  context: DEFAULT_CONTEXT,
  hearing: "auto",        // auto = OpenAI when set up, otherwise iPhone; apple = iPhone only
  sensitivity: "normal",  // OpenAI hearing: how loud speech must be
  pause: "normal",        // OpenAI hearing: how long a pause ends a phrase
  script: "simplified",
  fontSize: "M",
  showPinyin: true,
  autoSpeak: true,
  verifyFirst: true,
  autoSwitch: true,       // iPhone hearing: alternate turns
  rate: 0.92,
  passcode: "",
};

const FONT_SIZES = { S: 13, M: 15, L: 18, XL: 22 };
const COLORS = { en: "#58a6ff", zh: "#f78166" };
const SPEECH_LANG = { en: "en-AU", zh: "zh-CN" };
const SLOW_RATE = 0.62;
const CN_FONT = "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";

const other = side => (side === "en" ? "zh" : "en");
const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode or full */ }
}

function initialSettings() {
  const stored = load(SETTINGS_KEY, {}) || {};
  return { ...DEFAULT_SETTINGS, ...stored, names: { ...DEFAULT_SETTINGS.names, ...(stored.names || {}) } };
}
function initialEntries() {
  const stored = load(CONVO_KEY, []);
  if (!Array.isArray(stored)) return [];
  // Anything mid-translation when the app closed can be retried.
  return stored.map(e => (e.status === "translating" || e.status === "checking")
    ? { ...e, status: "error", error: "Interrupted when the app closed." }
    : e);
}

export default function App() {
  const [settings, setSettings] = useState(initialSettings);
  const [entries, setEntries] = useState(initialEntries);
  const [convoOn, setConvoOn] = useState(false);
  const [mode, setMode] = useState(null);          // hearing in use: "openai" | "apple"
  const [cloudReady, setCloudReady] = useState(null); // is OpenAI hearing set up on the server?
  const [turn, setTurn] = useState("en");
  const [phase, setPhase] = useState("idle");      // idle | listening | transcribing | translating | checking | speaking
  const [listeningSide, setListeningSide] = useState(null);
  const [speakingTo, setSpeakingTo] = useState(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [pending, setPending] = useState(0);
  const [liveText, setLiveText] = useState("");
  const [notice, setNotice] = useState("");
  const [panel, setPanel] = useState(null);        // settings | export | type
  const [exportLang, setExportLang] = useState("en");
  const [typed, setTyped] = useState({ en: "", zh: "" });
  const [exportMsg, setExportMsg] = useState("");

  const listenerRef = useRef(null);
  if (!listenerRef.current) listenerRef.current = new Listener();
  const cloudRef = useRef(null);
  if (!cloudRef.current) cloudRef.current = new CloudListener();
  const convoRef = useRef(false);
  const modeRef = useRef(null);
  const chainRef = useRef(Promise.resolve());
  const pendingRef = useRef(0);
  const epochRef = useRef(0);          // bumped by Stop: queued work finishes but stays quiet
  const oneShotSideRef = useRef(null); // tap-to-talk with OpenAI hearing
  const nextOverrideRef = useRef(null);
  const errorStreakRef = useRef(0);
  const audioStoreRef = useRef(new Map()); // audio kept in memory so a failed transcription can be retried
  const meterRef = useRef(null);
  const bottomRef = useRef(null);

  // Always-current values for callbacks that outlive a render (mic, speech, network).
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const entriesRef = useRef(entries); entriesRef.current = entries;
  const turnRef = useRef(turn); turnRef.current = turn;
  const phaseRef = useRef(phase); phaseRef.current = phase;
  const fns = useRef({});

  const names = settings.names;
  const fs = FONT_SIZES[settings.fontSize] || 15;

  useEffect(() => { save(SETTINGS_KEY, settings); }, [settings]);
  useEffect(() => { save(CONVO_KEY, entries); }, [entries]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [entries.length, liveText]);
  useEffect(() => { cloudRef.current.configure({ sensitivity: settings.sensitivity, pause: settings.pause }); }, [settings.sensitivity, settings.pause]);
  useEffect(() => { cloudHearingAvailable().then(setCloudReady); }, []);

  useEffect(() => {
    const synth = window.speechSynthesis;
    const loadVoices = () => synth?.getVoices();
    loadVoices();
    synth?.addEventListener?.("voiceschanged", loadVoices);
    return () => synth?.removeEventListener?.("voiceschanged", loadVoices);
  }, []);

  const setSetting = (key, value) => setSettings(prev => ({ ...prev, [key]: value }));
  const updateEntry = (id, patch) => setEntries(prev => prev.map(e => (e.id === id ? { ...e, ...patch } : e)));
  const pageVisible = () => document.visibilityState === "visible";

  /** Which hearing to use for the next conversation or tap. */
  function chooseMode() {
    const s = settingsRef.current;
    if (s.hearing !== "apple" && cloudReady && cloudCaptureSupported) return "openai";
    return "apple";
  }

  // ── Work queue: everything said is handled strictly in order ───────────
  function enqueue(task) {
    pendingRef.current += 1;
    setPending(pendingRef.current);
    chainRef.current = chainRef.current
      .then(task)
      .catch(err => console.error(err))
      .finally(() => {
        pendingRef.current -= 1;
        setPending(pendingRef.current);
        if (pendingRef.current === 0) {
          if (!convoRef.current && !oneShotSideRef.current) { if (phaseRef.current !== "listening") setPhase("idle"); }
          else if (modeRef.current === "openai") setPhase("listening");
        }
      });
  }

  // ── Speaking ──────────────────────────────────────────────────────────
  /** Speak, deafening the mic meanwhile. Resolves when finished or cancelled. */
  function speakAsync(text, side, rate) {
    return new Promise(resolve => {
      listenerRef.current.stop();
      setListeningSide(null);
      cloudRef.current.setGated(true);
      setPhase("speaking");
      setSpeakingTo(side);
      speak(text, SPEECH_LANG[side], {
        rate: rate || settingsRef.current.rate,
        onEnd: () => {
          cloudRef.current.setGated(false);
          setSpeakingTo(null);
          resolve();
        },
      });
    });
  }

  // ── iPhone hearing (one language at a time, taking turns) ─────────────
  function listen(side) {
    if (!recognitionSupported) {
      setNotice("Speech recognition isn't available here. Open the app in Safari on iPhone, or use ⌨ Type.");
      stopConversation();
      return;
    }
    stopSpeaking();
    setTurn(side);
    setListeningSide(side);
    setPhase("listening");
    setLiveText("");
    listenerRef.current.start(SPEECH_LANG[side], {
      onInterim: t => setLiveText(t),
      onResult: t => {
        errorStreakRef.current = 0;
        setListeningSide(null);
        setLiveText("");
        enqueue(async () => {
          const outcome = await processUtterance(t, side);
          appleNext(side, outcome);
        });
      },
      onSilence: () => {
        setLiveText("");
        if (convoRef.current) {
          // Nobody spoke yet: keep listening for the same person.
          setTimeout(() => {
            if (convoRef.current && !pendingRef.current && !listenerRef.current.active && phaseRef.current === "listening" && pageVisible()) {
              fns.current.listen(turnRef.current);
            }
          }, 250);
        } else {
          setListeningSide(null);
          setPhase("idle");
        }
      },
      onError: err => {
        setListeningSide(null);
        setLiveText("");
        if (err === "not-allowed" || err === "service-not-allowed") {
          stopConversation();
          setNotice("The microphone is blocked. On iPhone: Settings → Apps → Safari → Microphone → Allow, then tap Start again.");
          return;
        }
        if (convoRef.current && !pageVisible()) return;
        errorStreakRef.current += 1;
        if (convoRef.current && errorStreakRef.current < 5) {
          setTimeout(() => { if (convoRef.current && !pendingRef.current && pageVisible()) fns.current.listen(turnRef.current); }, 800);
        } else {
          stopConversation();
          setPhase("idle");
          setNotice(`Microphone problem (${err}). Tap Start to try again.`);
        }
      },
    });
  }

  /** After a line with iPhone hearing: hand the mic to whoever speaks next. */
  function appleNext(side, outcome) {
    if (!convoRef.current || modeRef.current !== "apple") return;
    const s = settingsRef.current;
    const next = nextOverrideRef.current
      ?? (outcome === "garbled" ? other(side) : outcome === "error" ? side : s.autoSwitch ? other(side) : side);
    nextOverrideRef.current = null;
    fns.current.listen(next);
  }

  // ── OpenAI hearing (always listening, language detected) ──────────────
  function cloudHandlers() {
    return {
      onLevel: v => { if (meterRef.current) meterRef.current.style.transform = `scaleX(${v.toFixed(2)})`; },
      onVoiceStart: () => setVoiceActive(true),
      onNoise: () => setVoiceActive(false),
      onPhrase: wav => {
        setVoiceActive(false);
        const forced = oneShotSideRef.current;
        if (forced) {
          oneShotSideRef.current = null;
          cloudRef.current.close();
          setListeningSide(null);
        }
        enqueue(() => handlePhrase(wav, forced));
      },
    };
  }

  /** Open the mic for OpenAI hearing. Call straight from a tap. */
  async function startCloud() {
    const cl = cloudRef.current;
    cl.configure({ sensitivity: settingsRef.current.sensitivity, pause: settingsRef.current.pause });
    try {
      await cl.open();
    } catch (err) {
      oneShotSideRef.current = null;
      setListeningSide(null);
      if (err.message === "not-allowed") {
        stopConversation();
        setNotice("The microphone is blocked. On iPhone: Settings → Apps → Safari → Microphone → Allow, then tap Start again.");
      } else {
        setNotice("Couldn't open the microphone for OpenAI hearing, so the iPhone's own hearing is being used instead.");
        modeRef.current = "apple";
        setMode("apple");
        if (convoRef.current) listen(turnRef.current);
      }
      return;
    }
    cl.start(cloudHandlers());
    if (!pendingRef.current) setPhase("listening");
  }

  async function handlePhrase(wav, forcedSide) {
    const s = settingsRef.current;
    setPhase("transcribing");
    let text;
    try {
      text = await transcribeAudio(wav, s);
    } catch (err) {
      const id = newId();
      audioStoreRef.current.set(id, { wav, forcedSide });
      setEntries(prev => [...prev, {
        id, speaker: forcedSide || null, heard: "", source: "", translated: "",
        status: "error", error: err?.message || "Couldn't hear that.", time: new Date().toISOString(), audioRetry: true,
      }]);
      return;
    }
    if (isPhantom(text, s.names)) return;
    const side = forcedSide || detectSide(text);
    await processUtterance(text, side, { cloud: true });
  }

  // ── The translation pipeline ──────────────────────────────────────────
  /**
   * Understand, translate, check and (unless stopped) speak one line.
   * Returns "ok" | "garbled" | "noise" | "error".
   */
  async function processUtterance(text, side, { typedIn = false, cloud = false, replaceId = null } = {}) {
    const s = settingsRef.current;
    const epoch = epochRef.current;
    const id = newId();
    const history = entriesRef.current.filter(e => e.status === "done" && e.id !== replaceId).slice(-6);
    const fresh = {
      id, speaker: side, heard: text, source: text, translated: "", cloud,
      status: "translating", verify: null, time: new Date().toISOString(), typed: typedIn,
    };
    setEntries(prev => (replaceId ? prev.map(e => (e.id === replaceId ? fresh : e)) : [...prev, fresh]));
    setPhase("translating");
    const hearing = typedIn ? "typed" : cloud ? "openai" : "apple";
    const maySpeak = () => s.autoSpeak && epochRef.current === epoch;

    try {
      const r = await translateUtterance({ text, side, settings: { ...s, hearing }, history });

      if (r.garbled && !typedIn) {
        if (cloud) {
          // With OpenAI hearing this is background noise, a TV, or a mumble: just note it.
          updateEntry(id, { status: "garbled", garbledReason: "noise" });
          return "noise";
        }
        // iPhone hearing: probably the other person talking on the wrong turn.
        updateEntry(id, { status: "garbled", garbledReason: "wrong-turn" });
        const next = other(side);
        if (epochRef.current === epoch) {
          await speakAsync(next === "zh" ? "不好意思，请再说一遍。" : "Sorry, could you say that again?", next);
        }
        return "garbled";
      }

      updateEntry(id, {
        source: r.heardAs, translated: r.translation, tone: r.tone,
        notes: r.notes, notesZh: r.notesZh, check: r.check, checkZh: r.checkZh, ask: r.ask,
        status: s.verifyFirst ? "checking" : "done",
        verify: s.verifyFirst ? "pending" : "background",
      });

      let finalText = r.translation;
      if (s.verifyFirst) {
        setPhase("checking");
        const v = await verifyTranslation({ source: r.heardAs, translation: r.translation, side, settings: s });
        finalText = v.translation;
        updateEntry(id, { translated: finalText, verify: v.status, issue: v.issue, back: v.back, rounds: v.rounds, status: "done" });
      } else {
        verifyTranslation({ source: r.heardAs, translation: r.translation, side, settings: s })
          .then(v => updateEntry(id, v.status === "pass"
            ? { verify: "pass", back: v.back }
            : { verify: v.status === "unchecked" ? "unchecked" : "fail", issue: v.issue, back: v.back, suggested: v.translation !== r.translation ? v.translation : null }))
          .catch(() => updateEntry(id, { verify: "unchecked" }));
      }

      const chinese = side === "zh" ? r.heardAs : finalText;
      fetchPinyin(chinese, s).then(p => p && updateEntry(id, { pinyin: p })).catch(() => { /* optional */ });

      if (maySpeak()) await speakAsync(finalText, other(side));
      return "ok";
    } catch (err) {
      updateEntry(id, { status: "error", error: err?.message || "Something went wrong." });
      return "error";
    }
  }

  // ── Starting and stopping ─────────────────────────────────────────────
  function startConversation() {
    unlockSpeech();
    setNotice("");
    setPanel(null);
    errorStreakRef.current = 0;
    const m = chooseMode();
    modeRef.current = m;
    setMode(m);
    convoRef.current = true;
    setConvoOn(true);
    if (m === "openai") startCloud();
    else if (!pendingRef.current) listen(turnRef.current);
  }

  function stopConversation() {
    convoRef.current = false;
    epochRef.current += 1;
    setConvoOn(false);
    nextOverrideRef.current = null;
    oneShotSideRef.current = null;
    listenerRef.current.stop();
    cloudRef.current.close();
    setListeningSide(null);
    setLiveText("");
    setVoiceActive(false);
    stopSpeaking();
    if (!pendingRef.current) setPhase("idle");
  }

  // Tap on a person's button.
  function tapSide(side) {
    if (convoOn) {
      if (modeRef.current === "openai") { cloudRef.current.finishNow(); return; } // "I've finished"
      if (listeningSide === side) { listenerRef.current.finish(); return; }
      if (pendingRef.current) { nextOverrideRef.current = side; setTurn(side); return; }
      listen(side); // switch who we're listening to
      return;
    }
    if (listeningSide === side) {
      // Second tap: send what was said, or cancel if nothing was said yet.
      if (modeRef.current === "openai") {
        if (cloudRef.current.hearingVoice) cloudRef.current.finishNow();
        else { oneShotSideRef.current = null; cloudRef.current.close(); setListeningSide(null); if (!pendingRef.current) setPhase("idle"); }
      } else listenerRef.current.finish();
      return;
    }
    if (pendingRef.current || listeningSide) return;
    unlockSpeech();
    setNotice("");
    const m = chooseMode();
    modeRef.current = m;
    setMode(m);
    if (m === "openai") {
      oneShotSideRef.current = side;
      setListeningSide(side);
      setTurn(side);
      startCloud();
    } else listen(side);
  }

  // Keep the screen awake during a conversation, and pick up again after the
  // phone comes back from the lock screen or another app.
  useEffect(() => {
    if (!convoOn) return;
    let lock = null;
    const acquire = async () => {
      try { if ("wakeLock" in navigator) lock = await navigator.wakeLock.request("screen"); } catch { /* not supported */ }
    };
    acquire();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || !convoRef.current) return;
      acquire();
      if (modeRef.current === "openai") {
        const cl = cloudRef.current;
        cl.open()
          .then(() => {
            if (!cl.audioRunning) throw new Error("suspended");
            cl.start(fns.current.cloudHandlers());
          })
          .catch(() => {
            fns.current.stopConversation();
            setNotice("Paused while the phone was locked. Tap ▶ Start to carry on.");
          });
      } else if (!pendingRef.current && phaseRef.current !== "speaking") {
        fns.current.listen(turnRef.current);
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      lock?.release?.().catch(() => {});
    };
  }, [convoOn]);

  fns.current = { listen, cloudHandlers, stopConversation };

  // ── Entry actions ─────────────────────────────────────────────────────
  function retry(entry) {
    const audio = audioStoreRef.current.get(entry.id);
    setEntries(prev => prev.filter(e => e.id !== entry.id));
    if (entry.audioRetry) {
      if (!audio) return;
      audioStoreRef.current.delete(entry.id);
      enqueue(() => handlePhrase(audio.wav, audio.forcedSide));
      return;
    }
    enqueue(() => processUtterance(entry.heard, entry.speaker, { typedIn: entry.typed, cloud: entry.cloud }));
  }

  /** The app guessed the wrong person: redo the line as the other speaker. */
  function swapSpeaker(entry) {
    enqueue(() => processUtterance(entry.heard, other(entry.speaker), { cloud: entry.cloud, typedIn: entry.typed, replaceId: entry.id }));
  }

  function replay(text, side, slow = false) {
    if (pendingRef.current || phase === "speaking") return;
    const resumeApple = convoRef.current && modeRef.current === "apple";
    enqueue(async () => {
      await speakAsync(text, side, slow ? SLOW_RATE : undefined);
      if (resumeApple && convoRef.current) fns.current.listen(turnRef.current);
    });
  }

  function askToConfirm(entry) {
    if (pendingRef.current || !entry.ask) return;
    enqueue(async () => {
      await speakAsync(entry.ask, "zh");
      if (convoRef.current && modeRef.current === "apple") fns.current.listen("zh");
      else if (!convoRef.current) setTurn("zh");
    });
  }

  function submitTyped(side) {
    const text = typed[side].trim();
    if (!text) return;
    unlockSpeech();
    if (modeRef.current === "apple") listenerRef.current.stop();
    setTyped(prev => ({ ...prev, [side]: "" }));
    enqueue(async () => {
      const outcome = await processUtterance(text, side, { typedIn: true });
      if (convoRef.current && modeRef.current === "apple") appleNext(side, outcome);
    });
  }

  function clearConversation() {
    if (entries.length && !window.confirm("Clear the whole conversation? Save a copy first if you want to keep it.")) return;
    stopConversation();
    setEntries([]);
    audioStoreRef.current.clear();
    setPanel(null);
  }

  async function doExport(type) {
    if (!entries.some(e => e.status === "done")) return;
    let msg = "";
    if (type === "copy") {
      try { await navigator.clipboard.writeText(toText(entries, names, exportLang)); msg = exportLang === "zh" ? "已复制 ✓" : "Copied ✓"; }
      catch { msg = "Couldn't copy. Try Text instead."; }
    } else {
      const content = type === "txt" ? toText(entries, names, exportLang)
        : type === "csv" ? toCsv(entries, names, exportLang)
        : toHtml(entries, names, exportLang);
      const mime = { txt: "text/plain;charset=utf-8", csv: "text/csv;charset=utf-8", html: "text/html;charset=utf-8" }[type];
      msg = await deliverFile(exportFilename(entries, names, type, exportLang), content, mime);
    }
    setExportMsg(msg);
    setTimeout(() => setExportMsg(""), 2500);
  }

  // ── Status line ───────────────────────────────────────────────────────
  const busy = phase === "transcribing" || phase === "translating" || phase === "checking";
  const cloudListening = mode === "openai" && (convoOn || listeningSide);
  const waiting = pending > 1 ? ` (+${pending - 1} waiting)` : "";
  let statusText;
  if (phase === "listening" && mode === "openai" && cloudListening) {
    statusText = voiceActive ? "🎙 Hearing…"
      : listeningSide ? `🎤 Listening to ${names[listeningSide]}…`
      : `🎤 Listening to you both…`;
  } else if (phase === "listening" && listeningSide) {
    statusText = listeningSide === "en" ? `🎤 Listening to ${names.en}…` : `🎤 Listening to ${names.zh} · 请说话…`;
  } else if (phase === "transcribing") statusText = `Working out what was said…${waiting}`;
  else if (phase === "translating") statusText = `Translating…${waiting}`;
  else if (phase === "checking") statusText = `Checking accuracy before speaking…${waiting}`;
  else if (phase === "speaking") statusText = `🔊 Speaking to ${names[speakingTo] || ""}…${waiting}`;
  else if (convoOn) statusText = "Getting the mic ready…";
  else statusText = "Ready";
  const statusColor = phase === "listening" ? (COLORS[listeningSide] || "#3fb950")
    : busy ? "#f0883e" : phase === "speaking" ? "#3fb950" : "#8b949e";

  const hearingLabel = settings.hearing === "apple" ? "iPhone hearing"
    : cloudReady && cloudCaptureSupported ? "OpenAI hearing" : "iPhone hearing";
  const doneCount = entries.filter(e => e.status === "done").length;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div style={{
      height: "100dvh", background: "#0d1117", color: "#e6edf3",
      fontFamily: "'IBM Plex Sans','Helvetica Neue',sans-serif",
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>

      {/* Header */}
      <div style={{
        background: "#161b22", borderBottom: "1px solid #30363d",
        padding: "calc(10px + env(safe-area-inset-top)) 16px 10px",
        display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, gap: 8,
      }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 19, fontWeight: 700, color: "#58a6ff" }}>译 · Translate</div>
          <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: "0.4px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {names.en} · English ↔ 普通话 / 重庆话 · {names.zh} · {hearingLabel}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          <button onClick={() => setPanel(p => (p === "type" ? null : "type"))} style={iconBtn(panel === "type")} aria-label="Type">⌨</button>
          <button onClick={() => setPanel(p => (p === "export" ? null : "export"))} style={iconBtn(panel === "export")}>↑ Save</button>
          <button onClick={() => setPanel(p => (p === "settings" ? null : "settings"))} style={iconBtn(panel === "settings")} aria-label="Settings">⚙</button>
        </div>
      </div>

      {/* Settings */}
      {panel === "settings" && (
        <div style={panelStyle}>
          <Row label="Names">
            <div style={{ display: "flex", gap: 6, flex: 1, minWidth: 0 }}>
              <input value={names.en} onChange={e => setSetting("names", { ...names, en: e.target.value })}
                style={{ ...inputStyle, borderColor: COLORS.en }} aria-label="English speaker's name" />
              <input value={names.zh} onChange={e => setSetting("names", { ...names, zh: e.target.value })}
                style={{ ...inputStyle, borderColor: COLORS.zh }} aria-label="Chinese speaker's name" />
            </div>
          </Row>
          <div>
            <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 4 }}>About you both (sets the tone and wording)</div>
            <textarea value={settings.context} onChange={e => setSetting("context", e.target.value)} rows={2}
              placeholder={DEFAULT_CONTEXT}
              style={{ ...inputStyle, width: "100%", resize: "vertical", fontFamily: "inherit" }} />
          </div>
          <Row label="Hearing">
            <ToggleGroup options={[{ v: "auto", l: "OpenAI" }, { v: "apple", l: "iPhone" }]}
              value={settings.hearing} onChange={v => setSetting("hearing", v)} />
            <span style={{ fontSize: 11, color: cloudReady ? "#3fb950" : "#8b949e" }}>
              {cloudReady === null ? "checking…" : cloudReady ? (cloudCaptureSupported ? "OpenAI ready ✓" : "not on this browser") : "OpenAI not set up"}
            </span>
          </Row>
          {settings.hearing !== "apple" && (
            <>
              <Row label="Mic pickup">
                <ToggleGroup options={[{ v: "low", l: "Noisy room" }, { v: "normal", l: "Normal" }, { v: "high", l: "Quiet voices" }]}
                  value={settings.sensitivity} onChange={v => setSetting("sensitivity", v)} />
              </Row>
              <Row label="Wait for pause">
                <ToggleGroup options={[{ v: "short", l: "Short" }, { v: "normal", l: "Normal" }, { v: "long", l: "Long" }]}
                  value={settings.pause} onChange={v => setSetting("pause", v)} />
              </Row>
            </>
          )}
          {settings.hearing === "apple" && (
            <Row label="Turns">
              <ToggleGroup options={[{ v: "on", l: "Auto-switch" }, { v: "off", l: "Same person" }]}
                value={settings.autoSwitch ? "on" : "off"} onChange={v => setSetting("autoSwitch", v === "on")} />
            </Row>
          )}
          <Row label="Check first">
            <ToggleGroup options={[{ v: "on", l: "✓ Before speaking" }, { v: "off", l: "⚡ After" }]}
              value={settings.verifyFirst ? "on" : "off"} onChange={v => setSetting("verifyFirst", v === "on")} />
          </Row>
          <Row label="Speak aloud">
            <ToggleGroup options={[{ v: "on", l: "🔊 On" }, { v: "off", l: "🔇 Off" }]}
              value={settings.autoSpeak ? "on" : "off"} onChange={v => setSetting("autoSpeak", v === "on")} />
          </Row>
          <Row label="Voice speed">
            <ToggleGroup options={[{ v: 0.8, l: "Slow" }, { v: 0.92, l: "Normal" }, { v: 1.05, l: "Fast" }]}
              value={settings.rate} onChange={v => setSetting("rate", v)} />
          </Row>
          <Row label="Script">
            <ToggleGroup options={[{ v: "simplified", l: "简 Simplified" }, { v: "traditional", l: "繁 Traditional" }]}
              value={settings.script} onChange={v => setSetting("script", v)} />
          </Row>
          <Row label="Pinyin">
            <ToggleGroup options={[{ v: "on", l: "On" }, { v: "off", l: "Off" }]}
              value={settings.showPinyin ? "on" : "off"} onChange={v => setSetting("showPinyin", v === "on")} />
          </Row>
          <Row label="Text size">
            <ToggleGroup options={Object.keys(FONT_SIZES).map(k => ({ v: k, l: k }))}
              value={settings.fontSize} onChange={v => setSetting("fontSize", v)} />
          </Row>
          <Row label="Passcode">
            <input value={settings.passcode} onChange={e => setSetting("passcode", e.target.value.trim())}
              type="password" autoComplete="off" placeholder="Only if set up in Netlify"
              style={{ ...inputStyle, flex: 1 }} />
          </Row>
          <button onClick={clearConversation}
            style={{ ...pill, background: "#2d1111", color: "#f85149", border: "1px solid #3d1c1c", alignSelf: "flex-start" }}>
            Clear conversation
          </button>
        </div>
      )}

      {/* Export */}
      {panel === "export" && (
        <div style={panelStyle}>
          <div style={{ fontSize: 11, color: "#8b949e", fontWeight: 700, letterSpacing: "0.6px" }}>
            SAVE THE RECORD · {doneCount} exchanges · English + 中文 side by side
          </div>
          <Row label="Copy for">
            <ToggleGroup options={[{ v: "en", l: `${names.en} (English notes)` }, { v: "zh", l: `${names.zh}（中文注释）` }]}
              value={exportLang} onChange={setExportLang} />
          </Row>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {(exportLang === "zh"
              ? [["html", "🌐 网页"], ["txt", "📄 文本"], ["csv", "📊 表格"], ["copy", "📋 复制"]]
              : [["html", "🌐 Page"], ["txt", "📄 Text"], ["csv", "📊 Spreadsheet"], ["copy", "📋 Copy"]]
            ).map(([t, l]) => (
              <button key={t} onClick={() => doExport(t)} disabled={!doneCount}
                style={{ ...pill, opacity: doneCount ? 1 : 0.4 }}>{l}</button>
            ))}
          </div>
          <div style={{ fontSize: 12, color: "#8b949e" }}>
            Shares through the iPhone share sheet (Messages, WeChat, Mail, Files). The conversation is also kept on
            this phone until you clear it.
          </div>
          {exportMsg && <div style={{ fontSize: 13, color: "#3fb950" }}>{exportMsg}</div>}
        </div>
      )}

      {/* Status */}
      <div style={{
        background: "#0d1117", borderBottom: "1px solid #21262d", padding: "6px 16px",
        fontSize: 13, flexShrink: 0, color: statusColor, display: "flex", alignItems: "center", gap: 6, minHeight: 30,
        position: "relative",
      }}>
        {(phase !== "idle") && <span style={{ animation: "pulse 0.9s infinite" }}>●</span>}
        <span>{statusText}</span>
        {cloudListening && (
          <div aria-hidden style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "#21262d" }}>
            <div ref={meterRef} style={{ height: "100%", background: "#3fb950", transformOrigin: "left", transform: "scaleX(0)", transition: "transform 80ms linear" }} />
          </div>
        )}
      </div>
      {notice && (
        <div onClick={() => setNotice("")} style={{
          background: "#2d1d05", color: "#f0b35e", fontSize: 13, padding: "8px 16px",
          borderBottom: "1px solid #4d3410", flexShrink: 0,
        }}>{notice} <span style={{ opacity: 0.6 }}>(tap to hide)</span></div>
      )}

      {/* Conversation */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {entries.length === 0 && <EmptyState names={names} openai={hearingLabel === "OpenAI hearing"} />}

        {entries.map(entry => (
          <EntryCard key={entry.id} entry={entry} names={names} fs={fs} settings={settings}
            canAct={!pending && phase !== "speaking"}
            canRetryAudio={!!audioStoreRef.current.get(entry.id)}
            onReplay={replay} onRetry={retry} onAsk={askToConfirm} onSwap={swapSpeaker} />
        ))}

        {liveText && listeningSide && (
          <div style={{
            alignSelf: listeningSide === "en" ? "flex-start" : "flex-end", maxWidth: "88%", flexShrink: 0,
            border: `1px dashed ${COLORS[listeningSide]}`, borderRadius: 10, padding: "8px 12px",
            color: "#c9d1d9", fontSize: fs, fontFamily: listeningSide === "zh" ? CN_FONT : undefined,
          }}>
            <span style={{ fontSize: 10, color: COLORS[listeningSide], fontWeight: 700, display: "block" }}>
              {names[listeningSide].toUpperCase()} · HEARING…
            </span>
            {liveText}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Typed input */}
      {panel === "type" && (
        <div style={{ ...panelStyle, borderTop: "1px solid #30363d", borderBottom: "none" }}>
          {["en", "zh"].map(side => (
            <div key={side} style={{ display: "flex", gap: 6 }}>
              <input value={typed[side]}
                onChange={e => setTyped(p => ({ ...p, [side]: e.target.value }))}
                onKeyDown={e => e.key === "Enter" && submitTyped(side)}
                placeholder={side === "en" ? `${names.en}: type English…` : `${names.zh}：输入中文…`}
                style={{ ...inputStyle, flex: 1, fontSize: side === "zh" ? fs + 1 : fs, fontFamily: side === "zh" ? CN_FONT : "inherit" }} />
              <button onClick={() => submitTyped(side)} disabled={!typed[side].trim()}
                style={{ ...sendBtn, background: side === "en" ? "#1f6feb" : "#8b1a1a", opacity: !typed[side].trim() ? 0.4 : 1 }}>→</button>
            </div>
          ))}
        </div>
      )}

      {/* Controls */}
      <div style={{
        background: "#161b22", borderTop: "1px solid #30363d",
        padding: "12px 16px calc(12px + env(safe-area-inset-bottom))",
        display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 10, alignItems: "center", flexShrink: 0,
      }}>
        {["en", "zh"].map((side, i) => {
          const btn = (
            <SideButton key={side} side={side} name={names[side]}
              sub={side === "en" ? "English" : "普通话 · 重庆话"}
              convoOn={convoOn} openai={mode === "openai" && convoOn}
              listening={listeningSide === side || (mode === "openai" && convoOn && voiceActive)}
              highlighted={listeningSide === side || speakingTo === side || (convoOn && mode === "apple" && turn === side)}
              disabled={!convoOn && (busy || (listeningSide && listeningSide !== side))}
              onClick={() => tapSide(side)} />
          );
          if (i === 0) return btn;
          return [
            <button key="center" onClick={convoOn ? stopConversation : startConversation} style={{
              width: 68, height: 68, borderRadius: "50%", cursor: "pointer",
              border: `2px solid ${convoOn ? "#f85149" : "#3fb950"}`,
              background: convoOn ? "#2d1111" : "#0d2a0d", color: convoOn ? "#f85149" : "#3fb950",
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              fontSize: 11, fontWeight: 700, gap: 2,
            }} aria-label={convoOn ? "Stop conversation" : "Start conversation"}>
              <span style={{ fontSize: 22, lineHeight: 1 }}>{convoOn ? "■" : "▶"}</span>
              {convoOn ? "Stop" : "Start"}
            </button>,
            btn,
          ];
        })}
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=Noto+Sans+SC:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        body { overscroll-behavior: none; background: #0d1117; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.2} }
        input::placeholder, textarea::placeholder { color: #484f58; }
        button:disabled { cursor: not-allowed; }
        button { -webkit-user-select: none; user-select: none; font-family: inherit; }
        details summary { cursor: pointer; }
      `}</style>
    </div>
  );
}

// ── Pieces ────────────────────────────────────────────────────────────

function EmptyState({ names, openai }) {
  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", gap: 12, padding: 24 }}>
      <div style={{ fontSize: 60, color: "#30363d" }}>译</div>
      <div style={{ fontSize: 15, color: "#8b949e", maxWidth: 330, lineHeight: 1.5 }}>
        Tap <b style={{ color: "#3fb950" }}>▶ Start</b> and put the phone between you.
        {openai
          ? " Just talk. It hears you both and works out who is speaking from the language."
          : ` It listens to ${names.en} first, then ${names.zh}, taking turns.`}
      </div>
      <div style={{ fontSize: 13, color: "#6e7681", maxWidth: 330, lineHeight: 1.5 }}>
        {openai
          ? "Pause when you've finished, or tap your name to send straight away. Every translation is checked before it is spoken."
          : "Tap a name to switch who is speaking. Tap it again while they talk to say “I've finished”. Every translation is checked before it is spoken."}
      </div>
      <div style={{ fontSize: 13, color: "#6e7681", fontFamily: CN_FONT, maxWidth: 330, lineHeight: 1.6 }}>
        {openai
          ? `${names.zh}，直接说就可以，普通话或重庆话都行。说完停一下，或者点你的名字。`
          : `轮到${names.zh}说话时，按钮会变红。说普通话或重庆话都可以。`}
      </div>
    </div>
  );
}

function SideButton({ side, name, sub, convoOn, openai, listening, highlighted, disabled, onClick }) {
  const color = COLORS[side];
  const lit = highlighted || listening;
  let hint;
  if (openai) hint = side === "en" ? "Tap when finished" : "说完点一下";
  else if (listening) hint = side === "en" ? "Listening · tap when done" : "在听 · 说完点一下";
  else if (convoOn) hint = highlighted ? (side === "en" ? "Next to speak" : "下一个说") : (side === "en" ? "Tap to speak" : "点这里说话");
  else hint = side === "en" ? "Tap to speak" : "点击说话";
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 2, padding: "10px 6px", minHeight: 78, borderRadius: 12, cursor: "pointer",
      background: listening ? `${color}22` : "#0d1117",
      border: `2px solid ${lit ? color : "#30363d"}`,
      color: lit ? color : "#8b949e",
      boxShadow: listening ? `0 0 0 4px ${color}22` : "none",
      opacity: disabled ? 0.5 : 1, transition: "all 0.15s",
    }}>
      <span style={{ fontSize: 15, fontWeight: 700 }}>{listening ? "🎤 " : ""}{name}</span>
      <span style={{ fontSize: 10, opacity: 0.8, fontFamily: side === "zh" ? CN_FONT : undefined }}>{sub}</span>
      <span style={{ fontSize: 10, fontWeight: 600, marginTop: 2, fontFamily: side === "zh" ? CN_FONT : undefined }}>{hint}</span>
    </button>
  );
}

const VERIFY_BADGE = {
  pending: { t: "checking…", c: "#8b949e" },
  background: { t: "checking…", c: "#8b949e" },
  pass: { t: "✓ checked", c: "#3fb950" },
  fixed: { t: "✓ checked · corrected", c: "#3fb950" },
  fail: { t: "⚠ check this", c: "#f0883e" },
  unchecked: { t: "not checked", c: "#8b949e" },
};

function EntryCard({ entry, names, fs, settings, canAct, canRetryAudio, onReplay, onRetry, onAsk, onSwap }) {
  const side = entry.speaker;
  const color = COLORS[side] || "#8b949e";
  const who = names[side] || "Speech";
  const time = (() => { try { return new Date(entry.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } })();
  const align = side === "zh" ? "flex-end" : "flex-start";
  const base = {
    alignSelf: align, width: "92%", flexShrink: 0, background: "#161b22", borderRadius: 10, overflow: "hidden",
    border: `1px solid ${entry.verify === "fail" ? "#f0883e" : "#21262d"}`, borderLeft: `3px solid ${color}`,
  };
  const header = (
    <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.6px", display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 5 }}>
      <span style={{ color }}>{who.toUpperCase()}{entry.tone ? <span style={{ color: "#6e7681", fontWeight: 500 }}> · {entry.tone}</span> : null}</span>
      <span style={{ color: "#6e7681", fontWeight: 500, whiteSpace: "nowrap" }}>{time}</span>
    </div>
  );
  const ownFont = side === "zh" ? CN_FONT : undefined;
  const transFont = side === "en" ? CN_FONT : undefined;
  const replayRow = (text, lang) => (
    <div style={{ display: "flex", gap: 14, marginTop: 4 }}>
      <button onClick={() => onReplay(text, lang)} disabled={!canAct} style={linkBtn}>🔊 {lang === "zh" ? "重播" : "Replay"}</button>
      <button onClick={() => onReplay(text, lang, true)} disabled={!canAct} style={linkBtn}>🐢 {lang === "zh" ? "慢速" : "Slow"}</button>
    </div>
  );

  if (entry.status === "garbled") {
    return (
      <div style={{ ...base, opacity: 0.75, padding: "10px 12px" }}>
        {header}
        <div style={{ fontSize: fs - 1, color: "#8b949e", fontStyle: "italic", fontFamily: ownFont }}>“{entry.heard}”</div>
        <div style={{ fontSize: 12, color: "#f0b35e", marginTop: 4 }}>
          {entry.garbledReason === "noise"
            ? "Ignored: this sounded like background noise or a mumble, not something said to each other."
            : `Couldn't make sense of this. It sounded like ${names[other(side)]} talking, so they were asked to repeat it.`}
        </div>
      </div>
    );
  }

  if (entry.status === "error") {
    const retryable = entry.audioRetry ? canRetryAudio : !!entry.heard;
    return (
      <div style={{ ...base, padding: "10px 12px", borderColor: "#5a1e1e" }}>
        {header}
        {entry.heard && <div style={{ fontSize: fs, fontFamily: ownFont }}>{entry.heard}</div>}
        <div style={{ fontSize: 12, color: "#f85149", marginTop: 6, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span>{entry.error}</span>
          {retryable && <button onClick={() => onRetry(entry)} style={{ ...pill, padding: "4px 10px", color: "#e6edf3" }}>↻ Retry</button>}
        </div>
      </div>
    );
  }

  const badge = VERIFY_BADGE[entry.verify];
  const pinyin = settings.showPinyin && entry.pinyin;
  const done = entry.status === "done";

  return (
    <div style={base}>
      {/* What was said */}
      <div style={{ padding: "10px 12px", borderBottom: "1px solid #21262d" }}>
        {header}
        <div style={{ fontSize: side === "zh" ? fs + 2 : fs, lineHeight: 1.6, fontFamily: ownFont }}>{entry.source}</div>
        {pinyin && side === "zh" && <div style={pinyinStyle(fs)}>{entry.pinyin}</div>}
        {entry.heard && entry.heard !== entry.source && (
          <div style={{ fontSize: 11, color: "#6e7681", marginTop: 3, fontFamily: ownFont }}>Phone heard: {entry.heard}</div>
        )}
        {done && replayRow(entry.source, side)}
      </div>

      {/* Translation */}
      <div style={{ padding: "10px 12px" }}>
        <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.6px", marginBottom: 5, display: "flex", justifyContent: "space-between" }}>
          <span style={{ color: COLORS[other(side)] }}>{side === "en" ? "→ 普通话" : "→ ENGLISH"}</span>
          {badge && <span style={{ color: badge.c, fontWeight: 600 }}>{badge.t}</span>}
        </div>
        {entry.status === "translating" ? (
          <div style={{ color: "#6e7681", fontSize: fs }}>Translating…</div>
        ) : (
          <>
            <div style={{ fontSize: side === "en" ? fs + 3 : fs + 1, lineHeight: 1.65, fontFamily: transFont, color: entry.status === "checking" ? "#8b949e" : "#e6edf3" }}>
              {entry.translated}
            </div>
            {pinyin && side === "en" && <div style={pinyinStyle(fs)}>{entry.pinyin}</div>}
            {done && replayRow(entry.translated, other(side))}
          </>
        )}

        {entry.check && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#f0b35e", background: "#2d1d05", borderRadius: 6, padding: "6px 8px" }}>
            ❓ {entry.check}
            {entry.ask && done && (
              <div style={{ marginTop: 6 }}>
                <button onClick={() => onAsk(entry)} disabled={!canAct} style={{ ...pill, padding: "4px 10px", color: "#f0b35e", borderColor: "#4d3410" }}>
                  🗣 Ask {names.zh}: <span style={{ fontFamily: CN_FONT }}>{entry.ask}</span>
                </button>
              </div>
            )}
          </div>
        )}
        {entry.verify === "fail" && entry.issue && (
          <div style={{ marginTop: 8, fontSize: 12, color: "#f0883e" }}>
            ⚠ {entry.issue}
            {entry.suggested && <div style={{ marginTop: 4, fontFamily: transFont }}>Suggested: {entry.suggested}</div>}
          </div>
        )}
        {(entry.notes?.length > 0 || entry.notesZh?.length > 0) && (
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
            {(entry.notes || []).map((n, i) => (
              <div key={`e${i}`} style={{ fontSize: 12, color: "#8b949e", fontFamily: CN_FONT }}>📝 {n}</div>
            ))}
            {(entry.notesZh || []).map((n, i) => (
              <div key={`z${i}`} style={{ fontSize: 12, color: "#6e7681", fontFamily: CN_FONT }}>📝 {n}</div>
            ))}
          </div>
        )}
        {done && (entry.back || entry.cloud) && (
          <details style={{ marginTop: 8, fontSize: 12, color: "#6e7681" }}>
            <summary>How it was checked{entry.rounds > 1 ? ` (${entry.rounds} rounds)` : ""}</summary>
            {entry.back && <div style={{ marginTop: 4, fontFamily: ownFont }}>Back-translation: {entry.back}</div>}
            {entry.verify === "fixed" && entry.issue && <div style={{ marginTop: 2 }}>Corrected: {entry.issue}</div>}
            {entry.cloud && (
              <button onClick={() => onSwap(entry)} disabled={!canAct} style={{ ...linkBtn, marginTop: 6, color: "#8b949e" }}>
                ⇄ Wrong person? Redo this as {names[other(side)]}
              </button>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "#8b949e", width: 84, flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  );
}

function ToggleGroup({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", background: "#0d1117", borderRadius: 7, border: "1px solid #30363d", overflow: "hidden" }}>
      {options.map(o => (
        <button key={String(o.v)} onClick={() => onChange(o.v)} style={{
          padding: "6px 10px", fontSize: 12, fontWeight: 600, border: "none", cursor: "pointer",
          background: value === o.v ? "#1f6feb" : "transparent", color: value === o.v ? "#fff" : "#8b949e",
        }}>{o.l}</button>
      ))}
    </div>
  );
}

const pinyinStyle = fs => ({ fontSize: Math.max(fs - 2, 11), color: "#8b949e", marginTop: 3, fontStyle: "italic", lineHeight: 1.5 });

const panelStyle = {
  background: "#161b22", borderBottom: "1px solid #30363d", padding: "12px 16px",
  display: "flex", flexDirection: "column", gap: 10, flexShrink: 0, maxHeight: "55dvh", overflowY: "auto",
};

const pill = {
  padding: "6px 14px", fontSize: 12, fontWeight: 600, border: "1px solid #30363d",
  borderRadius: 7, cursor: "pointer", background: "transparent", color: "#8b949e",
};

const linkBtn = { background: "none", border: "none", color: "#6e7681", cursor: "pointer", fontSize: 11, padding: 0 };

const inputStyle = {
  background: "#0d1117", border: "1px solid #30363d", borderRadius: 8,
  padding: "8px 10px", color: "#e6edf3", outline: "none", fontSize: 15, minWidth: 0, flex: 1,
};

const sendBtn = { padding: "10px 14px", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontSize: 16, fontWeight: 700 };

function iconBtn(active) {
  return {
    padding: "7px 10px", fontSize: 13, fontWeight: 600,
    border: `1px solid ${active ? "#58a6ff" : "#30363d"}`, borderRadius: 8, cursor: "pointer",
    background: active ? "#0d1f3c" : "transparent", color: active ? "#58a6ff" : "#8b949e",
  };
}
