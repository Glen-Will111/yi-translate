import { useState, useRef, useEffect, useCallback } from "react";

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You are a professional bilingual interpreter with native-level fluency in both English and Mandarin Chinese. Your role is to provide accurate, natural-sounding translations that preserve the speaker's intent, tone, and nuance.

Rules:
- Translate English input → Mandarin Chinese (output ONLY the translation, no explanation)
- Translate Mandarin/Chinese input → English (output ONLY the translation, no explanation)
- Use natural spoken language, not overly formal or literal translations
- Preserve the speaker's tone (casual, formal, emotional, etc.)
- When the script variant is "simplified", use Simplified Chinese characters (Mainland China standard)
- When the script variant is "traditional", use Traditional Chinese characters (Taiwan/Hong Kong standard)
- Never add notes, parentheses, or explanatory text — only the translation itself
- If input is ambiguous or mixed language, translate the dominant language to the other`;

const PINYIN_PROMPT = `You are a Mandarin Chinese linguistics expert. Convert the following Chinese text to Pinyin with tone marks (not numbers).
Rules:
- Output ONLY the Pinyin, nothing else
- Use proper tone marks: ā á ǎ à, ē é ě è, ī í ǐ ì, ō ó ǒ ò, ū ú ǔ ù, ǖ ǘ ǚ ǜ
- Separate each syllable with a space
- No punctuation except where it mirrors the original`;

const VERIFY_PROMPT = `You are a translation quality checker. Receive an original text and its translation. Back-translate and assess meaning preservation. Respond ONLY with JSON: {"accurate": true/false, "issue": "description or null"}. No other text.`;

async function callClaude(messages, systemPrompt) {
  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`API error ${res.status}`);
  const data = await res.json();
  return data.content?.[0]?.text?.trim() || "";
}

function getLangCode(script) {
  return script === "traditional" ? "zh-TW" : "zh-CN";
}

const FONT_SIZES = { S: 13, M: 15, L: 18, XL: 22 };

export default function App() {
  const [script, setScript] = useState("simplified");
  const [conversation, setConversation] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const [activeSide, setActiveSide] = useState(null);
  const [isTranslating, setIsTranslating] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [liveText, setLiveText] = useState("");
  const [autoSpeak, setAutoSpeak] = useState(true);
  const [showPinyin, setShowPinyin] = useState(false);
  const [fontSize, setFontSize] = useState("M");
  const [flaggedItems, setFlaggedItems] = useState(new Set());
  const [typedText, setTypedText] = useState({ en: "", zh: "" });
  const [showSettings, setShowSettings] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [exportMsg, setExportMsg] = useState("");
  const [showInput, setShowInput] = useState(false);

  const recognitionRef = useRef(null);
  const latestTranscriptRef = useRef("");
  const activeSideRef = useRef(null);
  const bottomRef = useRef(null);
  const synthRef = useRef(window.speechSynthesis);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation]);

  useEffect(() => {
    const load = () => synthRef.current?.getVoices();
    load();
    window.speechSynthesis?.addEventListener("voiceschanged", load);
    return () => window.speechSynthesis?.removeEventListener("voiceschanged", load);
  }, []);

  const speakText = useCallback((text, lang) => {
    const synth = synthRef.current;
    if (!synth) return;
    synth.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = lang === "zh" ? getLangCode(script) : "en-AU";
    utt.rate = 0.92;
    const voices = synth.getVoices();
    if (lang === "zh") {
      const v = voices.find(v => v.lang.startsWith(script === "traditional" ? "zh-TW" : "zh-CN"))
             || voices.find(v => v.lang.startsWith("zh"));
      if (v) utt.voice = v;
    }
    synth.speak(utt);
  }, [script]);

  const verifyTranslation = useCallback(async (original, translated, id) => {
    try {
      const result = await callClaude([
        { role: "user", content: `Original: "${original}"\nTranslation: "${translated}"` }
      ], VERIFY_PROMPT);
      const parsed = JSON.parse(result);
      if (!parsed.accurate) setFlaggedItems(prev => new Set([...prev, id]));
    } catch { /* silent */ }
  }, []);

  const fetchPinyin = useCallback(async (chineseText, id) => {
    try {
      const pinyin = await callClaude([{ role: "user", content: chineseText }], PINYIN_PROMPT);
      setConversation(prev => prev.map(e => e.id === id ? { ...e, pinyin } : e));
    } catch { /* silent */ }
  }, []);

  const translate = useCallback(async (text, sourceLang) => {
    setIsTranslating(true);
    setStatus("Translating…");
    try {
      const translation = await callClaude([
        { role: "user", content: `Script variant: ${script}\n\n${text}` }
      ], SYSTEM_PROMPT);

      const id = Date.now();
      const chineseText = sourceLang === "zh" ? text : translation;
      setConversation(prev => [...prev, {
        id, original: text, translated: translation,
        sourceLang, targetLang: sourceLang === "en" ? "zh" : "en",
        timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        pinyin: null,
      }]);
      setStatus("Ready");
      if (autoSpeak) speakText(translation, sourceLang === "en" ? "zh" : "en");
      verifyTranslation(text, translation, id);
      fetchPinyin(chineseText, id);
    } catch {
      setStatus("Error — check connection");
    } finally {
      setIsTranslating(false);
    }
  }, [script, autoSpeak, speakText, verifyTranslation, fetchPinyin]);

  const stopListening = useCallback((translateOnStop = false) => {
    const transcript = latestTranscriptRef.current.trim();
    const side = activeSideRef.current;
    try { recognitionRef.current?.abort(); } catch { /* ignore */ }
    recognitionRef.current = null;
    latestTranscriptRef.current = "";
    activeSideRef.current = null;
    setIsListening(false);
    setActiveSide(null);
    setLiveText("");
    if (translateOnStop && transcript && side) {
      translate(transcript, side);
    }
  }, [translate]);

  const startListening = useCallback((side) => {
    if (!("webkitSpeechRecognition" in window) && !("SpeechRecognition" in window)) {
      setStatus("Speech recognition not available");
      return;
    }
    // Tap to stop if already listening on same side
    if (isListening && activeSide === side) {
      stopListening(true); // true = translate whatever we captured
      return;
    }
    stopListening(false);
    synthRef.current?.cancel();

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    recognitionRef.current = rec;
    latestTranscriptRef.current = "";
    activeSideRef.current = side;
    rec.lang = side === "en" ? "en-AU" : getLangCode(script);
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setIsListening(true);
      setActiveSide(side);
      setStatus(side === "en" ? "Listening… tap mic to stop" : "聆听中… 点击停止");
    };
    rec.onresult = (e) => {
      const interim = Array.from(e.results).map(r => r[0].transcript).join("");
      setLiveText(interim);
      latestTranscriptRef.current = interim; // always store latest for iOS
      if (e.results[e.results.length - 1].isFinal) {
        const final = e.results[e.results.length - 1][0].transcript;
        latestTranscriptRef.current = "";
        setLiveText("");
        stopListening(false);
        translate(final, side);
      }
    };
    rec.onerror = (e) => {
      if (e.error !== "aborted" && e.error !== "no-speech") {
        setStatus(`Mic error: ${e.error}`);
      }
      stopListening(false);
    };
    rec.onend = () => {
      // iOS often ends without firing isFinal — catch it here
      const transcript = latestTranscriptRef.current.trim();
      const currentSide = activeSideRef.current;
      if (transcript && currentSide) {
        latestTranscriptRef.current = "";
        activeSideRef.current = null;
        setIsListening(false);
        setActiveSide(null);
        setLiveText("");
        translate(transcript, currentSide);
      } else {
        setIsListening(false);
        setActiveSide(null);
      }
    };
    rec.start();
  }, [isListening, activeSide, script, stopListening, translate]);

  const handleTypedSubmit = useCallback((side) => {
    const text = typedText[side].trim();
    if (!text) return;
    setTypedText(prev => ({ ...prev, [side]: "" }));
    setShowInput(false);
    translate(text, side);
  }, [typedText, translate]);

  // Export functions
  const doExport = useCallback((type) => {
    if (!conversation.length) return;
    if (type === "copy") {
      const lines = conversation.map(e => {
        const en = e.sourceLang === "en" ? e.original : e.translated;
        const zh = e.sourceLang === "zh" ? e.original : e.translated;
        return `[${e.timestamp}]\nEN: ${en}\nZH: ${zh}${e.pinyin ? `\nPinyin: ${e.pinyin}` : ""}`;
      }).join("\n\n");
      navigator.clipboard.writeText(lines).then(() => {
        setExportMsg("Copied ✓"); setTimeout(() => setExportMsg(""), 2000);
      });
      return;
    }
    const ext = type;
    let content, mime;
    if (type === "txt") {
      mime = "text/plain;charset=utf-8";
      content = conversation.map(e => {
        const en = e.sourceLang === "en" ? e.original : e.translated;
        const zh = e.sourceLang === "zh" ? e.original : e.translated;
        return `[${e.timestamp}]${flaggedItems.has(e.id) ? " ⚠" : ""}\nEN: ${en}\nZH: ${zh}${e.pinyin ? `\nPinyin: ${e.pinyin}` : ""}`;
      }).join("\n\n");
    } else if (type === "csv") {
      mime = "text/csv;charset=utf-8";
      const rows = conversation.map(e => {
        const en = (e.sourceLang === "en" ? e.original : e.translated).replace(/"/g, '""');
        const zh = (e.sourceLang === "zh" ? e.original : e.translated).replace(/"/g, '""');
        return `"${e.timestamp}","${en}","${zh}","${(e.pinyin||"").replace(/"/g,'""')}","${flaggedItems.has(e.id)?"Yes":"No"}"`;
      });
      content = ["Time,English,Chinese,Pinyin,Flagged", ...rows].join("\n");
    } else if (type === "html") {
      mime = "text/html;charset=utf-8";
      const rows = conversation.map(e => {
        const en = e.sourceLang === "en" ? e.original : e.translated;
        const zh = e.sourceLang === "zh" ? e.original : e.translated;
        return `<tr>
          <td style="padding:12px;border-right:1px solid #333;vertical-align:top">
            <div style="font-size:10px;color:#58a6ff;font-weight:700;margin-bottom:4px">EN · ${e.timestamp}${flaggedItems.has(e.id)?' <span style="color:#f0883e">⚠</span>':''}</div>
            <div style="font-size:15px">${en}</div>
          </td>
          <td style="padding:12px;vertical-align:top">
            <div style="font-size:10px;color:#f78166;font-weight:700;margin-bottom:4px">ZH</div>
            <div style="font-size:17px;font-family:sans-serif">${zh}</div>
            ${e.pinyin ? `<div style="font-size:12px;color:#8b949e;font-style:italic;margin-top:4px">${e.pinyin}</div>` : ""}
          </td>
        </tr>`;
      }).join("<tr><td colspan='2' style='height:1px;background:#222;padding:0'></td></tr>");
      content = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Translation Export</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px}
h1{color:#58a6ff}table{width:100%;border-collapse:collapse;border:1px solid #30363d;border-radius:8px;overflow:hidden}
td{background:#161b22}</style></head>
<body><h1>译 · Translation Export</h1><p style="color:#8b949e">${new Date().toLocaleString()} · ${conversation.length} exchanges</p>
<table>${rows}</table></body></html>`;
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `translation-${new Date().toISOString().slice(0,10)}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setExportMsg(`${ext.toUpperCase()} exported ✓`);
    setTimeout(() => setExportMsg(""), 2000);
  }, [conversation, flaggedItems]);

  const fs = FONT_SIZES[fontSize];
  const isBusy = isTranslating || isListening;

  return (
    <div style={{
      height: "100dvh",
      background: "#0d1117",
      color: "#e6edf3",
      fontFamily: "'IBM Plex Sans','Helvetica Neue',sans-serif",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
    }}>

      {/* ── Header ── */}
      <div style={{
        background: "#161b22",
        borderBottom: "1px solid #30363d",
        padding: "12px 16px env(safe-area-inset-top) 16px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        flexShrink: 0,
      }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#58a6ff" }}>译 · Translate</div>
          <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: "0.5px" }}>
            EN ↔ {script === "simplified" ? "普通话 简体" : "普通話 繁體"} · Claude AI
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => { setShowExport(p => !p); setShowSettings(false); }} style={iconBtn(showExport)}>
            ↑ Export
          </button>
          <button onClick={() => { setShowSettings(p => !p); setShowExport(false); }} style={iconBtn(showSettings)}>
            ⚙
          </button>
        </div>
      </div>

      {/* ── Settings panel ── */}
      {showSettings && (
        <div style={{
          background: "#161b22", borderBottom: "1px solid #30363d",
          padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12, flexShrink: 0,
        }}>
          <Row label="Script">
            <ToggleGroup
              options={[{v:"simplified",l:"简 Simplified"},{v:"traditional",l:"繁 Traditional"}]}
              value={script} onChange={setScript} />
          </Row>
          <Row label="Font size">
            <ToggleGroup
              options={Object.keys(FONT_SIZES).map(k=>({v:k,l:k}))}
              value={fontSize} onChange={setFontSize} />
          </Row>
          <Row label="Pinyin">
            <ToggleGroup
              options={[{v:"on",l:"ON"},{v:"off",l:"OFF"}]}
              value={showPinyin?"on":"off"}
              onChange={v => setShowPinyin(v==="on")} />
          </Row>
          <Row label="Auto-speak">
            <ToggleGroup
              options={[{v:"on",l:"🔊 ON"},{v:"off",l:"🔇 OFF"}]}
              value={autoSpeak?"on":"off"}
              onChange={v => setAutoSpeak(v==="on")} />
          </Row>
          <button onClick={() => { setConversation([]); setFlaggedItems(new Set()); synthRef.current?.cancel(); setShowSettings(false); }}
            style={{ ...pill, background: "#2d1111", color: "#f85149", border: "1px solid #3d1c1c", alignSelf: "flex-start" }}>
            Clear conversation
          </button>
        </div>
      )}

      {/* ── Export panel ── */}
      {showExport && (
        <div style={{
          background: "#161b22", borderBottom: "1px solid #30363d",
          padding: "12px 16px", flexShrink: 0,
        }}>
          <div style={{ fontSize: 11, color: "#484f58", fontWeight: 700, letterSpacing: "0.6px", marginBottom: 10 }}>
            EXPORT · {conversation.length} exchange{conversation.length !== 1 ? "s" : ""}
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[["txt","📄 Text"],["html","🌐 HTML"],["csv","📊 CSV"],["copy","📋 Copy"]].map(([t,l]) => (
              <button key={t} onClick={() => doExport(t)}
                disabled={!conversation.length}
                style={{ ...pill, opacity: conversation.length ? 1 : 0.4 }}>
                {l}
              </button>
            ))}
          </div>
          {exportMsg && <div style={{ fontSize: 13, color: "#3fb950", marginTop: 8 }}>{exportMsg}</div>}
        </div>
      )}

      {/* ── Status bar ── */}
      <div style={{
        background: "#0d1117", borderBottom: "1px solid #21262d",
        padding: "5px 16px", fontSize: 12, flexShrink: 0,
        color: isTranslating ? "#f0883e" : isListening ? "#3fb950" : "#8b949e",
        display: "flex", alignItems: "center", gap: 6, minHeight: 28,
      }}>
        {isBusy && <span style={{ animation: "pulse 0.8s infinite" }}>●</span>}
        <span>{status}</span>
        {liveText && <span style={{ color: "#c9d1d9", marginLeft: 4 }}>"{liveText}"</span>}
      </div>

      {/* ── Conversation ── */}
      <div style={{ flex: 1, overflowY: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10 }}>
        {conversation.length === 0 && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            color: "#30363d", textAlign: "center", gap: 12, padding: 32 }}>
            <div style={{ fontSize: 64 }}>译</div>
            <div style={{ fontSize: 15, color: "#484f58" }}>Tap a mic button to start</div>
            <div style={{ fontSize: 12, color: "#30363d" }}>English ↔ 普通话 · Pinyin · Export</div>
          </div>
        )}

        {conversation.map(entry => {
          const en = entry.sourceLang === "en" ? entry.original : entry.translated;
          const zh = entry.sourceLang === "zh" ? entry.original : entry.translated;
          const flagged = flaggedItems.has(entry.id);
          return (
            <div key={entry.id} style={{
              background: "#161b22",
              border: `1px solid ${flagged ? "#f0883e" : "#21262d"}`,
              borderRadius: 10, overflow: "hidden",
            }}>
              {/* English row */}
              <div style={{ padding: "10px 12px", borderBottom: "1px solid #21262d" }}>
                <div style={{ fontSize: 10, color: "#58a6ff", fontWeight: 700,
                  letterSpacing: "0.7px", marginBottom: 5,
                  display: "flex", justifyContent: "space-between" }}>
                  <span>ENGLISH {flagged && <span style={{ color: "#f0883e" }}>⚠</span>}</span>
                  <span style={{ color: "#484f58", fontWeight: 400 }}>{entry.timestamp}</span>
                </div>
                <div style={{ fontSize: fs, lineHeight: 1.6 }}>{en}</div>
                <button onClick={() => speakText(en, "en")}
                  style={{ marginTop: 4, background: "none", border: "none",
                    color: "#484f58", cursor: "pointer", fontSize: 11, padding: 0 }}>
                  🔊 Replay
                </button>
              </div>
              {/* Chinese row */}
              <div style={{ padding: "10px 12px" }}>
                <div style={{ fontSize: 10, color: "#f78166", fontWeight: 700,
                  letterSpacing: "0.7px", marginBottom: 5 }}>
                  {script === "simplified" ? "普通话 简体" : "普通話 繁體"}
                </div>
                <div style={{ fontSize: fs + 2, lineHeight: 1.7,
                  fontFamily: "'Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif" }}>
                  {zh}
                </div>
                {showPinyin && (
                  <div style={{ fontSize: Math.max(fs - 2, 11), color: "#8b949e",
                    marginTop: 4, fontStyle: "italic", lineHeight: 1.5 }}>
                    {entry.pinyin || <span style={{ color: "#30363d" }}>fetching…</span>}
                  </div>
                )}
                <button onClick={() => speakText(zh, "zh")}
                  style={{ marginTop: 4, background: "none", border: "none",
                    color: "#484f58", cursor: "pointer", fontSize: 11, padding: 0 }}>
                  🔊 重播
                </button>
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      {/* ── Typed input panel (collapsible) ── */}
      {showInput && (
        <div style={{
          background: "#161b22", borderTop: "1px solid #30363d",
          padding: "12px 16px", display: "flex", flexDirection: "column", gap: 10, flexShrink: 0,
        }}>
          {/* English typed */}
          <div style={{ display: "flex", gap: 6 }}>
            <input value={typedText.en}
              onChange={e => setTypedText(p => ({ ...p, en: e.target.value }))}
              onKeyDown={e => e.key === "Enter" && handleTypedSubmit("en")}
              placeholder="Type English…"
              style={{ ...inputStyle, fontSize: fs }} />
            <button onClick={() => handleTypedSubmit("en")}
              disabled={!typedText.en.trim() || isTranslating}
              style={{ ...sendBtn, background: "#1f6feb", opacity: (!typedText.en.trim()||isTranslating)?0.4:1 }}>→</button>
          </div>
          {/* Mandarin typed */}
          <div style={{ display: "flex", gap: 6 }}>
            <input value={typedText.zh}
              onChange={e => setTypedText(p => ({ ...p, zh: e.target.value }))}
              onKeyDown={e => e.key === "Enter" && handleTypedSubmit("zh")}
              placeholder="输入普通话…"
              style={{ ...inputStyle, fontSize: fs + 2, fontFamily: "'Noto Sans SC','PingFang SC',sans-serif" }} />
            <button onClick={() => handleTypedSubmit("zh")}
              disabled={!typedText.zh.trim() || isTranslating}
              style={{ ...sendBtn, background: "#8b1a1a", opacity: (!typedText.zh.trim()||isTranslating)?0.4:1 }}>→</button>
          </div>
        </div>
      )}

      {/* ── Mic buttons ── */}
      <div style={{
        background: "#161b22",
        borderTop: "1px solid #30363d",
        padding: `12px 16px calc(12px + env(safe-area-inset-bottom)) 16px`,
        display: "grid",
        gridTemplateColumns: "1fr auto 1fr",
        gap: 10,
        alignItems: "center",
        flexShrink: 0,
      }}>
        {/* English mic */}
        <button onClick={() => startListening("en")} disabled={isTranslating} style={{
          ...micBtn,
          background: isListening && activeSide === "en" ? "#0d2a0d" : "#161b22",
          border: `2px solid ${isListening && activeSide === "en" ? "#3fb950" : "#30363d"}`,
          color: isListening && activeSide === "en" ? "#3fb950" : "#8b949e",
        }}>
          <span style={{ fontSize: 28 }}>🎤</span>
          <span style={{ fontSize: 11, fontWeight: 700 }}>
            {isListening && activeSide === "en" ? "Tap to stop" : "English"}
          </span>
        </button>

        {/* Keyboard toggle */}
        <button onClick={() => setShowInput(p => !p)} style={{
          width: 44, height: 44, borderRadius: 10,
          background: showInput ? "#1f6feb22" : "transparent",
          border: `1px solid ${showInput ? "#1f6feb" : "#30363d"}`,
          color: showInput ? "#58a6ff" : "#484f58",
          cursor: "pointer", fontSize: 20, display: "flex",
          alignItems: "center", justifyContent: "center",
        }}>⌨</button>

        {/* Mandarin mic */}
        <button onClick={() => startListening("zh")} disabled={isTranslating} style={{
          ...micBtn,
          background: isListening && activeSide === "zh" ? "#2a0d0d" : "#161b22",
          border: `2px solid ${isListening && activeSide === "zh" ? "#f78166" : "#30363d"}`,
          color: isListening && activeSide === "zh" ? "#f78166" : "#8b949e",
        }}>
          <span style={{ fontSize: 28 }}>🎤</span>
          <span style={{ fontSize: 11, fontWeight: 700 }}>
            {isListening && activeSide === "zh" ? "点击停止" : "普通话"}
          </span>
        </button>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;600;700&family=Noto+Sans+SC:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }
        body { overscroll-behavior: none; }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 2px; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.2} }
        input::placeholder { color: #484f58; }
        button:disabled { cursor: not-allowed; }
        button { -webkit-user-select: none; user-select: none; }
      `}</style>
    </div>
  );
}

// ── Sub-components & shared styles ──────────────────────────────────────

function Row({ label, children }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: 12, color: "#8b949e", width: 72, flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  );
}

function ToggleGroup({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", background: "#0d1117", borderRadius: 7,
      border: "1px solid #30363d", overflow: "hidden" }}>
      {options.map(o => (
        <button key={o.v} onClick={() => onChange(o.v)} style={{
          padding: "6px 12px", fontSize: 12, fontWeight: 600,
          border: "none", cursor: "pointer",
          background: value === o.v ? "#1f6feb" : "transparent",
          color: value === o.v ? "#fff" : "#8b949e",
          transition: "all 0.15s",
        }}>{o.l}</button>
      ))}
    </div>
  );
}

const micBtn = {
  display: "flex", flexDirection: "column", alignItems: "center",
  justifyContent: "center", gap: 4, padding: "12px 8px",
  borderRadius: 12, cursor: "pointer", transition: "all 0.15s",
  minHeight: 70,
};

const pill = {
  padding: "6px 14px", fontSize: 12, fontWeight: 600,
  border: "1px solid #30363d", borderRadius: 7, cursor: "pointer",
  background: "transparent", color: "#8b949e",
};

const inputStyle = {
  flex: 1, background: "#0d1117", border: "1px solid #30363d",
  borderRadius: 8, padding: "10px 12px", color: "#e6edf3", outline: "none",
};

const sendBtn = {
  padding: "10px 14px", border: "none", borderRadius: 8,
  color: "#fff", cursor: "pointer", fontSize: 16, fontWeight: 700,
};

function iconBtn(active) {
  return {
    padding: "7px 12px", fontSize: 12, fontWeight: 600,
    border: `1px solid ${active ? "#58a6ff" : "#30363d"}`,
    borderRadius: 8, cursor: "pointer",
    background: active ? "#0d1f3c" : "transparent",
    color: active ? "#58a6ff" : "#8b949e",
  };
}
