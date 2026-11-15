// Chat: for when the two of you are apart. Each phone writes or speaks in its
// own language; the message is translated and checked on the sender's phone,
// then delivered to the other phone in their language.

import { useState, useRef, useEffect } from "react";
import { interpretLine, transcribeAudio, detectSide, isPhantom } from "./api.js";
import { speak, stopSpeaking } from "./speech.js";
import { CloudListener, cloudCaptureSupported } from "./cloudListener.js";
import { wordsDiffer } from "./text.js";
import {
  normaliseCode, formatCode, looksLikeCode, createRoom, fetchMessages, sendMessage,
  uploadAudio, audioUrl, alertSupport, enableAlerts, syncAlerts, disableAlerts, setBadge,
} from "./chat.js";

const STATE_KEY = "yi.chat.v1";
const MSGS_KEY = "yi.chat.msgs.v1";
const KEEP_ON_PHONE = 300;
const SLOW_RATE = 0.62;
const COLORS = { en: "#58a6ff", zh: "#f78166" };
const SPEECH_LANG = { en: "en-AU", zh: "zh-CN" };
const CN_FONT = "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";

const other = side => (side === "en" ? "zh" : "en");
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

// Everything the chat screen says, in the language of whoever holds the phone.
const TEXT = {
  en: {
    placeholder: n => `Message ${n}…`,
    send: "Send",
    connected: "connected", offline: "no connection, retrying…",
    stage: { transcribing: "working out what you said…", translating: "translating…", checking: "checking…", sending: "sending…" },
    sent: "sent", checked: "checked", corrected: "checked · corrected", flagged: "check this", unchecked: "not checked",
    failed: "Not sent", retry: "Retry", remove: "Delete",
    listen: "Listening… speak, then pause", hearing: "Hearing you… tap ⏹ when finished",
    didntCatch: "Didn't catch that. Try again.",
    micBlocked: "The microphone is blocked. Allow it in the phone's Settings for this app.",
    micFailed: "Couldn't open the microphone.",
    cantPlay: "Couldn't play the voice message.",
    voice: "Voice", slow: "Slow", hear: { en: "English", zh: "中文" },
    practising: { en: "practising English", zh: "practising Chinese" },
    ownWords: n => `${n}'s own words`, youWrote: "You wrote", standard: "Standard Mandarin",
    confirm: "To confirm",
    empty: n => `No messages yet. Write or speak in English and ${n} gets it in Mandarin.`,
    alertsOn: "Alerts on", alertsAsk: "Turn on alerts",
    alertsWhy: "Get an alert when a message arrives.",
    needsInstall: "To get alerts on iPhone, add this app to your Home Screen (Share → Add to Home Screen) and open it from there.",
    blocked: "Alerts are blocked for this app. Allow them in the phone's Settings → Notifications.",
    unsupported: "This browser can't show alerts. Open the app to check for messages.",
    later: "Not now",
    code: "Chat code", share: "Send the code", copied: "Copied ✓",
    codeHelp: n => `On ${n}'s phone: open the app → Chat → enter this code.`,
    thisPhone: "This phone is", leave: "Leave this chat",
    leaveConfirm: "Leave this chat on this phone? Messages already sent stay on the other phone.",
    roomGone: "This chat code no longer works. Leave the chat and start or join again.",
    today: "Today", yesterday: "Yesterday",
    invite: (code, url) => `译 Translate chat code: ${code}\nOpen the app → Chat → enter the code.\n${url}`,
  },
  zh: {
    placeholder: n => `给 ${n} 发消息…`,
    send: "发送",
    connected: "已连接", offline: "没有网络，正在重试…",
    stage: { transcribing: "正在识别你说的话…", translating: "正在翻译…", checking: "正在核对…", sending: "正在发送…" },
    sent: "已发送", checked: "已核对", corrected: "已核对 · 已修正", flagged: "请核对", unchecked: "未核对",
    failed: "发送失败", retry: "重试", remove: "删除",
    listen: "在听… 说完停一下", hearing: "正在听… 说完点 ⏹",
    didntCatch: "没听清，请再说一次。",
    micBlocked: "麦克风被禁用了，请在手机“设置”里允许本应用使用麦克风。",
    micFailed: "无法打开麦克风。",
    cantPlay: "无法播放语音。",
    voice: "语音", slow: "慢速", hear: { en: "English", zh: "中文" },
    practising: { en: "练习英语", zh: "练习中文" },
    ownWords: n => `${n} 的原话`, youWrote: "你写的", standard: "普通话",
    confirm: "需确认",
    empty: n => `还没有消息。用中文写或说，${n} 会收到英文。`,
    alertsOn: "提醒已开", alertsAsk: "开启提醒",
    alertsWhy: "有新消息时提醒你。",
    needsInstall: "iPhone 需要先把本应用添加到主屏幕（分享 → 添加到主屏幕），再从主屏幕打开，才能收到提醒。",
    blocked: "本应用的通知被关闭了，请在手机“设置 → 通知”里允许。",
    unsupported: "这个浏览器不支持提醒，请打开应用查看新消息。",
    later: "以后再说",
    code: "聊天码", share: "发送聊天码", copied: "已复制 ✓",
    codeHelp: n => `在 ${n} 的手机上：打开应用 → Chat → 输入这个聊天码。`,
    thisPhone: "这部手机是", leave: "退出这个聊天",
    leaveConfirm: "在这部手机上退出聊天？已发送的消息仍会留在对方手机上。",
    roomGone: "这个聊天码已失效。请退出聊天，然后重新创建或加入。",
    today: "今天", yesterday: "昨天",
    invite: (code, url) => `译 Translate 聊天码：${code}\n打开应用 → Chat → 输入聊天码。\n${url}`,
  },
};

function load(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode or full */ }
}
function initialMessages() {
  const stored = load(MSGS_KEY, []);
  if (!Array.isArray(stored)) return [];
  // Anything still being sent when the app closed can be retried.
  return stored.map(m => (m.status === "working" ? { ...m, status: "failed", error: null } : m));
}
const when = m => m.ts || m.localTs || 0;
const sortMessages = list => [...list].sort((a, b) => when(a) - when(b));

/** The fields that travel to the other phone. */
function toWire(m) {
  const { id, from, fromName, lang, source, heard, mandarin, translated, pinyin, tone, notes, notesZh, check, checkZh, verify, issue, back, audio, typed, time } = m;
  return { id, from, fromName, lang, source, heard, mandarin, translated, pinyin, tone, notes, notesZh, check, checkZh, verify, issue, back, audio, typed, time };
}

function useVisible() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

export default function Chat({ active, settings, cloudReady, fs, joinCode, onUnread, onEntries }) {
  const [cfg, setCfg] = useState(() => load(STATE_KEY, {}) || {});
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [recording, setRecording] = useState("off"); // off | listening | hearing
  const [online, setOnline] = useState(true);
  const [roomGone, setRoomGone] = useState(false);
  const [notice, setNotice] = useState("");
  const [panel, setPanel] = useState(null);           // "code" | null
  const [alertBusy, setAlertBusy] = useState(false);
  const [shareMsg, setShareMsg] = useState("");
  const visible = useVisible();

  const names = settings.names;
  const role = cfg.role || "en";
  const t = TEXT[role];
  const room = cfg.room || null;

  const tokenRef = useRef(null);
  const sinceRef = useRef(0);
  const activityRef = useRef(Date.now());
  const kickRef = useRef(null);
  const chainRef = useRef(Promise.resolve());
  const audioStoreRef = useRef(new Map()); // recordings kept until sent, so a failed send can be retried
  const cloudRef = useRef(null);
  if (!cloudRef.current) cloudRef.current = new CloudListener();
  const playerRef = useRef(null);
  const meterRef = useRef(null);
  const bottomRef = useRef(null);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const messagesRef = useRef(messages); messagesRef.current = messages;
  const activeRef = useRef(active); activeRef.current = active;
  const roomRef = useRef(room); roomRef.current = room;

  sinceRef.current = messages.reduce((max, m) => (m.ts > max ? m.ts : max), 0);

  useEffect(() => { save(STATE_KEY, cfg); }, [cfg]);
  useEffect(() => { save(MSGS_KEY, messages.slice(-KEEP_ON_PHONE)); }, [messages]);
  useEffect(() => {
    onEntries?.(messages.filter(m => m.status === "sent").map(m => ({
      ...m, speaker: m.from, status: "done", time: m.time || new Date(when(m)).toISOString(),
    })));
  }, [messages]);

  // ── Receiving ─────────────────────────────────────────────────────────
  function mergeIncoming(list) {
    if (!list?.length) return;
    if (list.some(m => m.from !== (cfg.role || "en"))) activityRef.current = Date.now();
    setMessages(prev => {
      const byId = new Map(prev.map(m => [m.id, m]));
      let changed = false;
      for (const m of list) {
        const old = byId.get(m.id);
        if (old?.status === "sent" && old.ts && old.ts <= m.ts) continue; // already have it
        byId.set(m.id, { ...m, status: "sent" });
        changed = true;
      }
      return changed ? sortMessages(byId.values()) : prev;
    });
  }
  const mergeRef = useRef(mergeIncoming); mergeRef.current = mergeIncoming;

  // Look for new messages: often while you're chatting, less often when idle,
  // not at all while the phone is locked (alerts cover that).
  useEffect(() => {
    if (!room) return undefined;
    let stopped = false;
    let timer = null;
    let count = 0;
    let failures = 0;
    const delay = () => {
      if (failures) return Math.min(30000, 3000 * 2 ** Math.min(failures, 4));
      if (!activeRef.current) return 45000;
      const idle = Date.now() - activityRef.current;
      return idle < 120000 ? 3000 : idle < 600000 ? 8000 : 30000;
    };
    let inFlight = false;
    let fullWanted = false;
    const tick = async (full) => {
      clearTimeout(timer);
      if (stopped) return;
      if (inFlight) { fullWanted = fullWanted || full === true; return; } // one look at a time
      inFlight = true;
      if (document.visibilityState === "visible") {
        try {
          const r = await fetchMessages(room, { token: tokenRef.current, since: sinceRef.current, full: full === true || count % 10 === 0 });
          if (stopped) return;
          count += 1;
          tokenRef.current = r.token;
          mergeRef.current(r.messages);
          failures = 0;
          setOnline(true);
          setRoomGone(false);
        } catch (err) {
          if (stopped) return;
          failures += 1;
          if (err.status === 404) setRoomGone(true); else setOnline(false);
        }
      }
      inFlight = false;
      if (stopped) return;
      if (fullWanted) { fullWanted = false; tick(true); return; }
      timer = setTimeout(tick, delay());
    };
    kickRef.current = () => tick(true);
    const onVisible = () => { if (document.visibilityState === "visible") tick(true); };
    document.addEventListener("visibilitychange", onVisible);
    tick(true);
    return () => {
      stopped = true;
      clearTimeout(timer);
      kickRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [room]);

  useEffect(() => { if (active) kickRef.current?.(); }, [active]);

  // Unread count: shown on the Chat tab and on the app icon.
  const latestTs = sinceRef.current;
  const unread = room ? messages.filter(m => m.from !== role && m.ts > (cfg.lastRead || 0)).length : 0;
  const reading = active && visible;
  useEffect(() => {
    if (reading && latestTs > (cfg.lastRead || 0)) { setCfg(c => ({ ...c, lastRead: latestTs })); return; }
    onUnread?.(reading ? 0 : unread);
    setBadge(reading ? 0 : unread);
  }, [reading, unread, latestTs]);

  useEffect(() => {
    if (active) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages.length, active]);

  // Keep this phone's alert address fresh on the server.
  useEffect(() => {
    if (room && cfg.alerts) syncAlerts(room, role).catch(() => {});
  }, [room, role, cfg.alerts]);

  // Leaving the Chat tab stops any recording.
  useEffect(() => {
    if (!active) { cloudRef.current.close(); setRecording("off"); }
  }, [active]);
  useEffect(() => () => cloudRef.current.close(), []);

  // ── Sending ───────────────────────────────────────────────────────────
  const patchMessage = (id, patch) => setMessages(prev => prev.map(m => (m.id === id ? { ...m, ...patch } : m)));
  const dropMessage = id => { audioStoreRef.current.delete(id); setMessages(prev => prev.filter(m => m.id !== id)); };
  const enqueue = task => { chainRef.current = chainRef.current.then(task).catch(err => console.error(err)); };
  const flash = text => { setNotice(text); setTimeout(() => setNotice(n => (n === text ? "" : n)), 4000); };

  function submit({ text, wav }) {
    const id = newId();
    const message = {
      id, from: role, fromName: names[role], lang: text ? detectSide(text) : role,
      source: text || "", heard: text || "", translated: "",
      status: "working", stage: wav ? "transcribing" : "translating",
      localTs: Date.now(), time: new Date().toISOString(), typed: !wav, audio: !!wav,
    };
    if (wav) audioStoreRef.current.set(id, wav);
    setMessages(prev => [...prev, message]);
    activityRef.current = Date.now();
    enqueue(() => deliver(message));
  }

  async function deliver(start) {
    let m = start;
    const patch = p => { m = { ...m, ...p }; patchMessage(m.id, p); };
    const s = settingsRef.current;
    const wav = audioStoreRef.current.get(m.id);
    try {
      if (!m.translated) {
        let text = m.source;
        if (!text) {
          text = await transcribeAudio(wav, s);
          if (isPhantom(text, s.names)) { dropMessage(m.id); flash(TEXT[m.from].didntCatch); return; }
          patch({ source: text, heard: text, lang: detectSide(text), stage: "translating" });
        }
        const history = messagesRef.current.filter(x => x.status === "sent").slice(-6)
          .map(x => ({ speaker: x.from, source: x.source, translated: x.translated }));
        const r = await interpretLine({
          text, side: m.lang, writer: m.from, settings: s, history,
          hearing: m.typed ? "typed" : "openai",
          onStage: stage => patch({ stage }),
        });
        if (r.garbled) { dropMessage(m.id); flash(TEXT[m.from].didntCatch); return; }
        const result = { ...r };
        delete result.garbled;
        patch(result);
      }
      patch({ status: "working", stage: "sending", error: null });
      let audio = false;
      if (m.audio && wav) {
        // The voice recording is a nice extra: never let it stop the message.
        try { await uploadAudio(roomRef.current, m.id, wav); audio = true; } catch { audio = false; }
      }
      const res = await sendMessage(roomRef.current, toWire({ ...m, audio }));
      patch({ status: "sent", ts: res.ts, audio, stage: null });
      activityRef.current = Date.now();
      // The recording stays in memory for this session so "Voice" plays instantly.
    } catch (err) {
      patch({ status: "failed", error: err?.message || null });
    }
  }

  function retry(m) {
    patchMessage(m.id, { status: "working", stage: m.translated ? "sending" : m.source ? "translating" : "transcribing", error: null });
    enqueue(() => deliver({ ...m, status: "working" }));
  }

  function sendDraft() {
    const text = draft.trim();
    if (!text || !room) return;
    setDraft("");
    submit({ text });
  }

  // ── Voice messages ────────────────────────────────────────────────────
  const canRecord = cloudReady && cloudCaptureSupported;

  async function toggleRecord() {
    const cl = cloudRef.current;
    if (recording !== "off") {
      if (cl.hearingVoice) cl.finishNow();
      else { cl.close(); setRecording("off"); }
      return;
    }
    stopSpeaking();
    try { playerRef.current?.pause(); } catch { /* ignore */ }
    setNotice("");
    setRecording("listening");
    cl.configure({ sensitivity: settings.sensitivity, pause: "long" }); // room to think mid-message
    try {
      await cl.open();
    } catch (err) {
      setRecording("off");
      flash(err.message === "not-allowed" ? t.micBlocked : t.micFailed);
      return;
    }
    cl.start({
      onLevel: v => { if (meterRef.current) meterRef.current.style.transform = `scaleX(${v.toFixed(2)})`; },
      onVoiceStart: () => setRecording("hearing"),
      onNoise: () => setRecording("listening"),
      onPhrase: wav => {
        cl.close();
        setRecording("off");
        submit({ wav });
      },
    });
  }

  // ── Listening back ────────────────────────────────────────────────────
  function say(text, lang, slow) {
    try { playerRef.current?.pause(); } catch { /* ignore */ }
    speak(text, SPEECH_LANG[lang], { rate: slow ? SLOW_RATE : settings.rate });
  }

  function playVoice(m) {
    stopSpeaking();
    const local = audioStoreRef.current.get(m.id);
    const player = playerRef.current || (playerRef.current = new Audio());
    player.src = local ? URL.createObjectURL(local) : audioUrl(room, m.id);
    player.play().catch(() => flash(t.cantPlay));
  }

  // ── Alerts ────────────────────────────────────────────────────────────
  const support = alertSupport();
  const alertsOn = !!cfg.alerts && support === "ok" && typeof Notification !== "undefined" && Notification.permission === "granted";

  async function turnOnAlerts() {
    setAlertBusy(true);
    try {
      await enableAlerts(room, role);
      setCfg(c => ({ ...c, alerts: true }));
    } catch (err) {
      flash(err.status === 403 ? t.blocked : (err?.message || t.unsupported));
    } finally {
      setAlertBusy(false);
    }
  }
  async function turnOffAlerts() {
    setCfg(c => ({ ...c, alerts: false, alertsDismissed: true }));
    await disableAlerts(room, role);
  }

  // ── Setting up, sharing, leaving ──────────────────────────────────────
  async function shareCode() {
    const text = t.invite(formatCode(room), `${window.location.origin}/?tab=chat&join=${room}`);
    try {
      if (navigator.share) { await navigator.share({ text }); return; }
      await navigator.clipboard.writeText(text);
      setShareMsg(t.copied);
      setTimeout(() => setShareMsg(""), 2500);
    } catch { /* cancelled */ }
  }

  async function leave() {
    if (!window.confirm(t.leaveConfirm)) return;
    cloudRef.current.close();
    await disableAlerts(room, role);
    audioStoreRef.current.clear();
    tokenRef.current = null;
    setMessages([]);
    setCfg({});
    setPanel(null);
    setRoomGone(false);
  }

  function changeRole(next) {
    if (next === role) return;
    // Alerts are registered per person, so move this phone's registration across.
    if (cfg.alerts) disableAlerts(room, role).then(() => syncAlerts(room, next)).catch(() => {});
    setCfg(c => ({ ...c, role: next }));
  }

  const hidden = { display: "none" };
  const shell = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column" };

  if (!room) {
    return (
      <div style={active ? shell : hidden}>
        <Setup settings={settings} joinCode={joinCode}
          onReady={(next, firstMessages, token) => {
            tokenRef.current = token || null;
            setMessages(sortMessages((firstMessages || []).map(m => ({ ...m, status: "sent" }))));
            setCfg(next);
            if (next.created) setPanel("code");
          }} />
      </div>
    );
  }

  const partner = names[other(role)];
  let lastDay = "";

  return (
    <div style={active ? shell : hidden}>
      {/* Who you're talking to, connection, alerts, code */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, padding: "6px 16px", flexShrink: 0,
        borderBottom: "1px solid #21262d", fontSize: 13, position: "relative",
      }}>
        <span style={{ color: COLORS[other(role)], fontWeight: 700 }}>{partner}</span>
        <span style={{ color: online ? "#3fb950" : "#f0883e", fontSize: 11, flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          ● {online ? t.connected : t.offline}
        </span>
        {alertsOn
          ? <button onClick={turnOffAlerts} style={chip(true)} aria-label={t.alertsOn}>🔔 {t.alertsOn}</button>
          : support === "ok" && cfg.alertsDismissed && <button onClick={turnOnAlerts} disabled={alertBusy} style={chip(false)}>🔕 {t.alertsAsk}</button>}
        <button onClick={() => setPanel(p => (p === "code" ? null : "code"))} style={chip(panel === "code")} aria-label={t.code}>⋯</button>
      </div>

      {panel === "code" && (
        <div style={{ ...card, margin: "8px 16px 0", flexShrink: 0 }}>
          <div style={{ fontSize: 11, color: "#8b949e", fontWeight: 700, letterSpacing: "0.6px" }}>{t.code.toUpperCase()}</div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "2px", fontFamily: "ui-monospace,Menlo,monospace", margin: "4px 0" }}>{formatCode(room)}</div>
          <div style={{ fontSize: 12, color: "#8b949e", marginBottom: 8, fontFamily: CN_FONT }}>{t.codeHelp(partner)}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <button onClick={shareCode} style={{ ...pill, color: "#e6edf3" }}>↑ {t.share}</button>
            {shareMsg && <span style={{ fontSize: 12, color: "#3fb950" }}>{shareMsg}</span>}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "#8b949e" }}>{t.thisPhone}</span>
            {["en", "zh"].map(r => (
              <button key={r} onClick={() => changeRole(r)} style={{
                ...pill, padding: "4px 10px",
                borderColor: role === r ? COLORS[r] : "#30363d", color: role === r ? COLORS[r] : "#8b949e",
              }}>{names[r]}</button>
            ))}
          </div>
          <button onClick={leave} style={{ ...pill, marginTop: 12, color: "#f85149", borderColor: "#3d1c1c" }}>{t.leave}</button>
        </div>
      )}

      {roomGone && <div style={warn}>{t.roomGone}</div>}

      {!alertsOn && !cfg.alertsDismissed && (
        <div style={{ ...card, margin: "8px 16px 0", flexShrink: 0, fontSize: 13, fontFamily: CN_FONT }}>
          {support === "ok" ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ flex: 1, minWidth: 140, color: "#c9d1d9" }}>🔔 {t.alertsWhy}</span>
              <button onClick={turnOnAlerts} disabled={alertBusy} style={{ ...pill, color: "#3fb950", borderColor: "#238636" }}>{t.alertsAsk}</button>
              <button onClick={() => setCfg(c => ({ ...c, alertsDismissed: true }))} style={linkBtn}>{t.later}</button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <span style={{ flex: 1, color: "#f0b35e" }}>🔔 {t[support === "needs-install" ? "needsInstall" : support === "blocked" ? "blocked" : "unsupported"]}</span>
              <button onClick={() => setCfg(c => ({ ...c, alertsDismissed: true }))} style={linkBtn} aria-label={t.later}>✕</button>
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 && (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", color: "#6e7681", fontSize: 14, padding: 24, lineHeight: 1.6, fontFamily: CN_FONT }}>
            {t.empty(partner)}
          </div>
        )}
        {messages.map(m => {
          const day = new Date(when(m)).toDateString();
          const showDay = day !== lastDay;
          lastDay = day;
          return (
            <div key={m.id} style={{ display: "contents" }}>
              {showDay && <div style={{ alignSelf: "center", fontSize: 11, color: "#6e7681", flexShrink: 0 }}>{dayLabel(when(m), t, role)}</div>}
              <Bubble m={m} viewer={role} names={names} t={t} fs={fs} showPinyin={settings.showPinyin}
                onSay={say} onVoice={playVoice} onRetry={retry} onRemove={() => dropMessage(m.id)}
                canRetry={!!(m.source || audioStoreRef.current.get(m.id))} />
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {(notice || recording !== "off") && (
        <div style={{ padding: "6px 16px", fontSize: 13, color: recording !== "off" ? COLORS[role] : "#f0b35e", flexShrink: 0, position: "relative", fontFamily: CN_FONT }}>
          {recording !== "off" ? `🎤 ${recording === "hearing" ? t.hearing : t.listen}` : notice}
          {recording !== "off" && (
            <div aria-hidden style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 2, background: "#21262d" }}>
              <div ref={meterRef} style={{ height: "100%", background: "#3fb950", transformOrigin: "left", transform: "scaleX(0)", transition: "transform 80ms linear" }} />
            </div>
          )}
        </div>
      )}

      {/* Write or speak */}
      <div style={{
        background: "#161b22", borderTop: "1px solid #30363d", flexShrink: 0,
        padding: "10px 12px calc(10px + env(safe-area-inset-bottom))", display: "flex", gap: 8, alignItems: "flex-end",
      }}>
        {canRecord && (
          <button onClick={toggleRecord} aria-label={recording === "off" ? "Record a voice message" : "Stop recording"} style={{
            ...roundBtn, border: `2px solid ${recording !== "off" ? "#f85149" : "#30363d"}`,
            background: recording !== "off" ? "#2d1111" : "#0d1117", color: recording !== "off" ? "#f85149" : "#8b949e",
          }}>{recording === "off" ? "🎤" : "⏹"}</button>
        )}
        <textarea value={draft} onChange={e => setDraft(e.target.value)} rows={Math.min(4, Math.max(1, draft.split("\n").length))}
          placeholder={t.placeholder(partner)} aria-label={t.placeholder(partner)}
          style={{
            flex: 1, minWidth: 0, resize: "none", background: "#0d1117", border: "1px solid #30363d", borderRadius: 18,
            padding: "10px 14px", color: "#e6edf3", outline: "none", fontSize: 16, lineHeight: 1.35,
            fontFamily: role === "zh" ? CN_FONT : "inherit",
          }} />
        <button onClick={sendDraft} disabled={!draft.trim()} aria-label={t.send} style={{
          ...roundBtn, border: "none", background: COLORS[role] === COLORS.en ? "#1f6feb" : "#b62324",
          color: "#fff", opacity: draft.trim() ? 1 : 0.4, fontSize: 20, fontWeight: 700,
        }}>↑</button>
      </div>
    </div>
  );
}

// ── One message ───────────────────────────────────────────────────────────

function Bubble({ m, viewer, names, t, fs, showPinyin, onSay, onVoice, onRetry, onRemove, canRetry }) {
  const mine = m.from === viewer;
  const color = COLORS[m.from];
  const working = m.status === "working";
  const failed = m.status === "failed";

  // Which text is English and which is Chinese (m.lang is the language it was written in).
  const english = m.lang === "en" ? m.source : m.translated;
  const standard = m.lang === "zh" ? (m.mandarin || m.source) : m.translated; // standard Mandarin
  const ownChinese = m.lang === "zh" && wordsDiffer(m.mandarin, m.source) ? m.source : null; // dialect, or a learner's attempt

  // The viewer reads their own language first, the other one underneath.
  // Lucy sees Chinese exactly as it was written; Glen sees standard Mandarin with pinyin.
  const chineseForViewer = viewer === "zh" && m.lang === "zh" ? m.source : standard;
  const extraChinese = !ownChinese ? null
    : viewer === "zh" ? { label: t.standard, text: m.mandarin }
    : { label: m.from === viewer ? t.youWrote : t.ownWords(names[m.from]), text: ownChinese };
  const primary = viewer === "en" ? english : chineseForViewer;
  const secondary = viewer === "en" ? chineseForViewer : english;
  const learning = other(viewer); // the language this person is learning
  const learnText = learning === "zh" ? standard : english;
  const notes = (viewer === "zh" && m.notesZh?.length ? m.notesZh : m.notes) || [];
  const check = viewer === "zh" ? (m.checkZh || m.check) : m.check;
  const time = (() => { try { return new Date(when(m)).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } })();

  let status;
  if (working) status = { text: t.stage[m.stage] || t.stage.sending, color: "#8b949e" };
  else if (failed) status = { text: t.failed, color: "#f85149" };
  else if (m.verify === "fail") status = { text: `⚠ ${t.flagged}`, color: "#f0883e" };
  else if (m.verify === "fixed") status = { text: `✓ ${t.corrected}`, color: "#3fb950" };
  else if (m.verify === "pass") status = { text: `✓ ${t.checked}`, color: "#3fb950" };
  else status = { text: t.unchecked, color: "#8b949e" };

  const cn = viewer === "en" ? {} : { fontFamily: CN_FONT };
  const cn2 = viewer === "en" ? { fontFamily: CN_FONT } : {};

  return (
    <div style={{
      alignSelf: mine ? "flex-end" : "flex-start", maxWidth: "88%", minWidth: "46%", flexShrink: 0,
      background: mine ? "#1c2533" : "#161b22", borderRadius: 14, padding: "9px 12px",
      border: `1px solid ${m.verify === "fail" || failed ? "#f0883e" : "#21262d"}`,
      [mine ? "borderRight" : "borderLeft"]: `3px solid ${color}`,
      opacity: working ? 0.8 : 1,
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.5px", display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <span style={{ color }}>
          {names[m.from]}
          {m.audio && " 🎤"}
          {m.lang !== m.from && <span style={{ color: "#8b949e", fontWeight: 500, fontFamily: CN_FONT }}> · ✍️ {t.practising[m.lang]}</span>}
        </span>
        <span style={{ color: "#6e7681", fontWeight: 500 }}>{time}</span>
      </div>

      {primary
        ? <div style={{ fontSize: viewer === "zh" ? fs + 2 : fs + 1, lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...cn }}>{primary}</div>
        : <div style={{ fontSize: fs, color: "#8b949e" }}>…</div>}
      {viewer === "zh" && extraChinese && (
        <div style={{ fontSize: 12, color: "#8b949e", marginTop: 2, fontFamily: CN_FONT }}>{extraChinese.label}：{extraChinese.text}</div>
      )}

      {secondary && (
        <div style={{ marginTop: 6, paddingTop: 6, borderTop: "1px solid #30363d" }}>
          <div style={{ fontSize: viewer === "en" ? fs + 1 : fs, lineHeight: 1.55, color: "#adbac7", whiteSpace: "pre-wrap", overflowWrap: "anywhere", ...cn2 }}>{secondary}</div>
          {viewer === "en" && showPinyin && m.pinyin && (
            <div style={{ fontSize: Math.max(fs - 2, 11), color: "#8b949e", fontStyle: "italic", lineHeight: 1.5 }}>{m.pinyin}</div>
          )}
          {viewer === "en" && extraChinese && (
            <div style={{ fontSize: 12, color: "#8b949e", marginTop: 2, fontFamily: CN_FONT }}>{extraChinese.label}: {extraChinese.text}</div>
          )}
        </div>
      )}

      {check && <div style={{ marginTop: 6, fontSize: 12, color: "#f0b35e", fontFamily: CN_FONT }}>❓ {t.confirm}: {check}</div>}
      {m.verify === "fail" && m.issue && viewer === "en" && <div style={{ marginTop: 4, fontSize: 12, color: "#f0883e" }}>⚠ {m.issue}</div>}
      {notes.map((n, i) => <div key={i} style={{ marginTop: 4, fontSize: 12, color: "#8b949e", fontFamily: CN_FONT }}>📝 {n}</div>)}
      {failed && m.error && <div style={{ marginTop: 4, fontSize: 12, color: "#f85149" }}>{m.error}</div>}

      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
        {m.status === "sent" && learnText && (
          <>
            <button onClick={() => onSay(learnText, learning, false)} style={linkBtn}>🔊 {t.hear[learning]}</button>
            <button onClick={() => onSay(learnText, learning, true)} style={linkBtn}>🐢 {t.slow}</button>
          </>
        )}
        {m.audio && !working && !failed && <button onClick={() => onVoice(m)} style={linkBtn}>▶ {t.voice}</button>}
        {failed && canRetry && <button onClick={() => onRetry(m)} style={{ ...pill, padding: "3px 10px", color: "#e6edf3" }}>↻ {t.retry}</button>}
        {failed && <button onClick={onRemove} style={linkBtn}>{t.remove}</button>}
        <span style={{ marginLeft: "auto", fontSize: 11, color: status.color, fontFamily: CN_FONT }}>{status.text}</span>
      </div>
    </div>
  );
}

// ── First-time setup: who is this, then start or join ─────────────────────

function Setup({ settings, joinCode, onReady }) {
  const names = settings.names;
  const [pick, setPick] = useState(() => ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en"));
  const [code, setCode] = useState(joinCode ? formatCode(normaliseCode(joinCode)) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function start() {
    setBusy(true); setError("");
    try {
      const room = await createRoom(settings.passcode);
      onReady({ room, role: pick, lastRead: 0, created: true }, [], null);
    } catch (err) {
      setError(err.status === 401
        ? "Passcode needed: enter it in ⚙ Settings first. · 需要先在 ⚙ 设置里输入密码。"
        : err.message);
    } finally { setBusy(false); }
  }

  async function join() {
    const room = normaliseCode(code);
    if (!looksLikeCode(room)) { setError("That code doesn't look right. · 聊天码不对。"); return; }
    setBusy(true); setError("");
    try {
      const r = await fetchMessages(room);
      onReady({ room, role: pick, lastRead: 0 }, r.messages, r.token);
    } catch (err) {
      setError(err.status === 404 ? "That code isn't recognised. · 找不到这个聊天码。" : err.message);
    } finally { setBusy(false); }
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 16px", display: "flex", flexDirection: "column", gap: 16, alignItems: "center" }}>
      <div style={{ textAlign: "center", maxWidth: 340 }}>
        <div style={{ fontSize: 17, fontWeight: 700 }}>Chat when you're apart</div>
        <div style={{ fontSize: 15, color: "#8b949e", fontFamily: CN_FONT }}>不在一起时也能聊天</div>
        <div style={{ fontSize: 13, color: "#8b949e", marginTop: 8, lineHeight: 1.5 }}>
          Each of you writes or speaks in your own language. The other gets it translated and checked.
        </div>
        <div style={{ fontSize: 13, color: "#8b949e", lineHeight: 1.6, fontFamily: CN_FONT }}>
          各自用自己的语言写或说，对方会收到核对过的翻译。
        </div>
      </div>

      <div style={{ ...card, width: "100%", maxWidth: 360 }}>
        <div style={stepLabel}>1 · Who uses this phone? <span style={{ fontFamily: CN_FONT }}>这部手机是谁的？</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {["en", "zh"].map(r => (
            <button key={r} onClick={() => setPick(r)} aria-pressed={pick === r} style={{
              padding: "12px 6px", borderRadius: 10, cursor: "pointer", background: pick === r ? `${COLORS[r]}22` : "#0d1117",
              border: `2px solid ${pick === r ? COLORS[r] : "#30363d"}`, color: pick === r ? COLORS[r] : "#8b949e",
              fontSize: 15, fontWeight: 700,
            }}>
              {names[r]}
              <div style={{ fontSize: 11, fontWeight: 500, fontFamily: CN_FONT }}>{r === "en" ? "English" : "中文"}</div>
            </button>
          ))}
        </div>
      </div>

      <div style={{ ...card, width: "100%", maxWidth: 360 }}>
        <div style={stepLabel}>2 · Have a chat code? <span style={{ fontFamily: CN_FONT }}>有聊天码吗？</span></div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="ABCDE-FGHJK"
            autoCapitalize="characters" autoCorrect="off" spellCheck={false} aria-label="Chat code"
            onKeyDown={e => e.key === "Enter" && join()}
            style={{
              flex: 1, minWidth: 0, background: "#0d1117", border: "1px solid #30363d", borderRadius: 8, padding: "10px 12px",
              color: "#e6edf3", outline: "none", fontSize: 18, letterSpacing: "1.5px", fontFamily: "ui-monospace,Menlo,monospace",
            }} />
          <button onClick={join} disabled={busy || !code.trim()} style={{ ...bigBtn, background: "#1f6feb", opacity: busy || !code.trim() ? 0.5 : 1 }}>
            Join <span style={{ fontFamily: CN_FONT }}>加入</span>
          </button>
        </div>
        <div style={{ textAlign: "center", color: "#6e7681", fontSize: 12, margin: "12px 0" }}>or · <span style={{ fontFamily: CN_FONT }}>或者</span></div>
        <button onClick={start} disabled={busy} style={{ ...bigBtn, width: "100%", background: "#238636", opacity: busy ? 0.5 : 1 }}>
          Start a new chat <span style={{ fontFamily: CN_FONT }}>新建聊天</span>
        </button>
        {error && <div style={{ color: "#f85149", fontSize: 13, marginTop: 10, fontFamily: CN_FONT }}>{error}</div>}
      </div>
    </div>
  );
}

function dayLabel(ms, t, role) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t.today;
  if (d.toDateString() === yesterday.toDateString()) return t.yesterday;
  return d.toLocaleDateString(role === "zh" ? "zh-CN" : undefined, { weekday: "short", day: "numeric", month: "short" });
}

const card = { background: "#161b22", border: "1px solid #30363d", borderRadius: 12, padding: "12px 14px" };
const warn = { background: "#2d1d05", color: "#f0b35e", fontSize: 13, padding: "8px 16px", flexShrink: 0, fontFamily: CN_FONT };
const stepLabel = { fontSize: 12, color: "#8b949e", fontWeight: 700, marginBottom: 10 };
const pill = {
  padding: "6px 14px", fontSize: 12, fontWeight: 600, border: "1px solid #30363d",
  borderRadius: 7, cursor: "pointer", background: "transparent", color: "#8b949e", fontFamily: CN_FONT,
};
const linkBtn = { background: "none", border: "none", color: "#8b949e", cursor: "pointer", fontSize: 12, padding: 0, fontFamily: CN_FONT };
const bigBtn = { padding: "10px 14px", border: "none", borderRadius: 8, color: "#fff", cursor: "pointer", fontSize: 15, fontWeight: 700 };
const roundBtn = {
  width: 44, height: 44, borderRadius: "50%", flexShrink: 0, cursor: "pointer", fontSize: 18,
  display: "flex", alignItems: "center", justifyContent: "center",
};
function chip(active) {
  return {
    padding: "4px 9px", fontSize: 11, fontWeight: 600, borderRadius: 12, cursor: "pointer", whiteSpace: "nowrap",
    border: `1px solid ${active ? "#238636" : "#30363d"}`, background: "transparent",
    color: active ? "#3fb950" : "#8b949e", fontFamily: CN_FONT,
  };
}
