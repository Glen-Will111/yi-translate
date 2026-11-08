// Turning the conversation record into files to keep, share and study from.
// Every export is bilingual. lang = "en" gives Glen's copy (English headings and
// notes), lang = "zh" gives Lucy's copy (Chinese headings and notes).

const L = {
  en: {
    title: n => `Conversation: ${n.en} & ${n.zh}`,
    count: k => `${k} exchanges`,
    exported: "exported",
    said: "said", translated: "translation", heard: "Phone heard",
    pinyin: "Pinyin", note: "Note", confirm: "To confirm", accuracy: "Accuracy",
    english: "English", chinese: "中文",
    verify: { pass: "Checked", fixed: "Checked (corrected)", fail: "CHECK: may be inaccurate", unchecked: "Not checked" },
    notChecked: "Not checked",
  },
  zh: {
    title: n => `对话记录：${n.en} 和 ${n.zh}`,
    count: k => `共 ${k} 条`,
    exported: "导出于",
    said: "原话", translated: "翻译", heard: "手机听到",
    pinyin: "拼音", note: "注释", confirm: "需确认", accuracy: "准确性",
    english: "English", chinese: "中文",
    verify: { pass: "已核对", fixed: "已核对（已修正）", fail: "请核对：可能不准确", unchecked: "未核对" },
    notChecked: "未核对",
  },
};

const fmtTime = iso => {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
};
const fmtDate = (iso, lang) => {
  try {
    return new Date(iso).toLocaleDateString(lang === "zh" ? "zh-CN" : undefined, { day: "numeric", month: "long", year: "numeric" });
  } catch { return ""; }
};

const usable = entries => entries.filter(e => e.status === "done");

const escapeHtml = s => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const csvCell = s => `"${String(s ?? "").replace(/"/g, '""')}"`;

/** The English text, Chinese text and which one was originally said. */
function sides(e) {
  return e.speaker === "en"
    ? { english: e.source, chinese: e.translated, originalIs: "en" }
    : { english: e.translated, chinese: e.source, originalIs: "zh" };
}
const notesFor = (e, lang) => (lang === "zh" && e.notesZh?.length ? e.notesZh : e.notes) || [];
const checkFor = (e, lang) => (lang === "zh" ? (e.checkZh || e.check) : e.check);
const verifyFor = (e, lang) => L[lang].verify[e.verify] || L[lang].notChecked;

function heading(rows, names, lang) {
  const first = rows[0]?.time;
  return `${L[lang].title(names)}${first ? ` · ${fmtDate(first, lang)}` : ""}`;
}

export function toText(entries, names, lang = "en") {
  const t = L[lang];
  const rows = usable(entries);
  const body = rows.map(e => {
    const s = sides(e);
    const tag = which => (s.originalIs === which ? t.said : t.translated);
    const lines = [`[${fmtTime(e.time)}] ${names[e.speaker]}${lang === "en" && e.tone ? ` (${e.tone})` : ""}`];
    lines.push(`  ${t.english} (${tag("en")}): ${s.english}`);
    lines.push(`  ${t.chinese} (${tag("zh")}): ${s.chinese}`);
    if (e.pinyin) lines.push(`  ${t.pinyin}: ${e.pinyin}`);
    if (e.heard && e.heard !== e.source) lines.push(`  ${t.heard}: ${e.heard}`);
    notesFor(e, lang).forEach(n => lines.push(`  ${t.note}: ${n}`));
    if (checkFor(e, lang)) lines.push(`  ${t.confirm}: ${checkFor(e, lang)}`);
    lines.push(`  ${t.accuracy}: ${verifyFor(e, lang)}${lang === "en" && e.issue ? `: ${e.issue}` : ""}`);
    return lines.join("\n");
  }).join("\n\n");
  return `${heading(rows, names, lang)}\n${"=".repeat(40)}\n\n${body}\n`;
}

export function toCsv(entries, names, lang = "en") {
  const header = lang === "zh"
    ? ["日期", "时间", "说话人", "English", "中文", "拼音", "原话语言", "手机听到", "注释", "需确认", "准确性"]
    : ["Date", "Time", "Speaker", "English", "Chinese", "Pinyin", "Originally said in", "Phone heard", "Notes", "To confirm", "Accuracy"];
  const rows = usable(entries).map(e => {
    const s = sides(e);
    return [
      fmtDate(e.time, lang), fmtTime(e.time), names[e.speaker], s.english, s.chinese, e.pinyin,
      s.originalIs === "en" ? "English" : "中文", e.heard !== e.source ? e.heard : "",
      notesFor(e, lang).join(" | "), checkFor(e, lang), verifyFor(e, lang),
    ].map(csvCell).join(",");
  });
  // BOM so Excel and Numbers open the Chinese characters correctly
  return "﻿" + [header.map(csvCell).join(","), ...rows].join("\n");
}

export function toHtml(entries, names, lang = "en") {
  const t = L[lang];
  const rows = usable(entries);
  const cards = rows.map(e => {
    const s = sides(e);
    const flag = e.verify === "fail";
    const label = which => `<span class="tag">${s.originalIs === which ? t.said : t.translated}</span>`;
    return `<div class="card ${e.speaker}${flag ? " flag" : ""}">
  <div class="meta"><b>${escapeHtml(names[e.speaker])}</b>${lang === "en" && e.tone ? ` · ${escapeHtml(e.tone)}` : ""} · ${fmtTime(e.time)}
    <span class="v">${escapeHtml(verifyFor(e, lang))}</span></div>
  <div class="pair">
    <div class="col"><div class="lbl">${t.english} ${label("en")}</div><div class="txt">${escapeHtml(s.english)}</div></div>
    <div class="col"><div class="lbl">${t.chinese} ${label("zh")}</div><div class="txt cn">${escapeHtml(s.chinese)}</div>
      ${e.pinyin ? `<div class="py">${escapeHtml(e.pinyin)}</div>` : ""}</div>
  </div>
  ${e.heard && e.heard !== e.source ? `<div class="small">${t.heard}: ${escapeHtml(e.heard)}</div>` : ""}
  ${notesFor(e, lang).map(n => `<div class="small">📝 ${escapeHtml(n)}</div>`).join("")}
  ${checkFor(e, lang) ? `<div class="small warn">${t.confirm}: ${escapeHtml(checkFor(e, lang))}</div>` : ""}
  ${lang === "en" && e.issue ? `<div class="small warn">${escapeHtml(e.issue)}</div>` : ""}
</div>`;
  }).join("\n");
  return `<!DOCTYPE html><html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading(rows, names, lang))}</title>
<style>
body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;max-width:820px;margin:32px auto;padding:0 16px;color:#1f2328;background:#fff}
h1{font-size:20px;margin-bottom:4px}.sub{color:#656d76;font-size:13px;margin-bottom:20px}
.card{border:1px solid #d0d7de;border-left:4px solid #0969da;border-radius:8px;padding:12px 14px;margin-bottom:12px;break-inside:avoid}
.card.zh{border-left-color:#cf222e}.card.flag{border-color:#bf8700;background:#fff8c5}
.meta{font-size:12px;color:#656d76;margin-bottom:8px}.v{float:right}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media (max-width:560px){.pair{grid-template-columns:1fr;gap:8px}}
.lbl{font-size:11px;color:#656d76;margin-bottom:2px}.tag{background:#f6f8fa;border:1px solid #d0d7de;border-radius:10px;padding:0 6px;margin-left:4px}
.txt{font-size:16px;line-height:1.5}.cn{font-family:"PingFang SC","Noto Sans SC",sans-serif;font-size:18px}
.py{font-size:13px;color:#656d76;font-style:italic;margin-top:2px}
.small{font-size:12px;color:#656d76;margin-top:6px}.warn{color:#9a6700}
</style></head><body>
<h1>${escapeHtml(heading(rows, names, lang))}</h1>
<div class="sub">${t.count(rows.length)} · ${t.exported} ${escapeHtml(new Date().toLocaleString(lang === "zh" ? "zh-CN" : undefined))}</div>
${cards}
</body></html>`;
}

/** Share through the iPhone share sheet (Save to Files, Mail, Messages, WeChat…), or download. */
export async function deliverFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  try {
    const file = new File([blob], filename, { type: mime });
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return "Shared ✓";
    }
  } catch (err) {
    if (err?.name === "AbortError") return "";
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return "Saved ✓";
}

export function exportFilename(entries, names, ext, lang = "en") {
  const first = usable(entries)[0]?.time || new Date().toISOString();
  const safe = s => String(s).replace(/[^\w一-鿿-]+/g, "");
  return `${safe(names.en)}-${safe(names.zh)}-${first.slice(0, 10)}${lang === "zh" ? "-zh" : ""}.${ext}`;
}
