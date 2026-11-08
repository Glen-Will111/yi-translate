// Turning the conversation record into files to keep or share.

const VERIFY_LABEL = {
  pass: "Checked",
  fixed: "Checked (corrected)",
  fail: "CHECK: may be inaccurate",
  unchecked: "Not checked",
  background: "Checking…",
  pending: "Checking…",
};

const fmtTime = iso => {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  catch { return ""; }
};
const fmtDate = iso => {
  try { return new Date(iso).toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" }); }
  catch { return ""; }
};

const usable = entries => entries.filter(e => e.status === "done");

const escapeHtml = s => String(s ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const csvCell = s => `"${String(s ?? "").replace(/"/g, '""')}"`;

function title(entries, names) {
  const first = entries[0]?.time;
  return `Conversation: ${names.en} & ${names.zh}${first ? ` · ${fmtDate(first)}` : ""}`;
}

export function toText(entries, names) {
  const rows = usable(entries);
  const body = rows.map(e => {
    const who = names[e.speaker];
    const lines = [`[${fmtTime(e.time)}] ${who}${e.tone ? ` (${e.tone})` : ""}`];
    lines.push(`  Said:       ${e.source}`);
    if (e.heard && e.heard !== e.source) lines.push(`  Phone heard: ${e.heard}`);
    lines.push(`  Translated: ${e.translated}`);
    if (e.pinyin) lines.push(`  Pinyin:     ${e.pinyin}`);
    (e.notes || []).forEach(n => lines.push(`  Note:       ${n}`));
    if (e.check) lines.push(`  To confirm: ${e.check}`);
    lines.push(`  Accuracy:   ${VERIFY_LABEL[e.verify] || "Not checked"}${e.issue ? `: ${e.issue}` : ""}`);
    return lines.join("\n");
  }).join("\n\n");
  return `${title(rows, names)}\n${"=".repeat(40)}\n\n${body}\n`;
}

export function toCsv(entries, names) {
  const header = ["Date", "Time", "Speaker", "Said", "Phone heard", "Translation", "Pinyin", "Tone", "Notes", "To confirm", "Accuracy", "Issue"];
  const rows = usable(entries).map(e => [
    fmtDate(e.time), fmtTime(e.time), names[e.speaker], e.source, e.heard, e.translated,
    e.pinyin, e.tone, (e.notes || []).join(" | "), e.check,
    VERIFY_LABEL[e.verify] || "Not checked", e.issue,
  ].map(csvCell).join(","));
  // BOM so Excel opens the Chinese characters correctly
  return "﻿" + [header.map(csvCell).join(","), ...rows].join("\n");
}

export function toHtml(entries, names) {
  const rows = usable(entries);
  const cards = rows.map(e => {
    const isEn = e.speaker === "en";
    const flag = e.verify === "fail";
    return `<div class="card ${isEn ? "en" : "zh"}${flag ? " flag" : ""}">
  <div class="meta"><b>${escapeHtml(names[e.speaker])}</b>${e.tone ? ` · ${escapeHtml(e.tone)}` : ""} · ${fmtTime(e.time)}
    <span class="v">${escapeHtml(VERIFY_LABEL[e.verify] || "Not checked")}</span></div>
  <div class="said ${isEn ? "" : "cn"}">${escapeHtml(e.source)}</div>
  ${e.heard && e.heard !== e.source ? `<div class="small">Phone heard: ${escapeHtml(e.heard)}</div>` : ""}
  <div class="tr ${isEn ? "cn" : ""}">${escapeHtml(e.translated)}</div>
  ${e.pinyin ? `<div class="small i">${escapeHtml(e.pinyin)}</div>` : ""}
  ${(e.notes || []).map(n => `<div class="small">📝 ${escapeHtml(n)}</div>`).join("")}
  ${e.check ? `<div class="small warn">To confirm: ${escapeHtml(e.check)}</div>` : ""}
  ${e.issue ? `<div class="small warn">Accuracy note: ${escapeHtml(e.issue)}</div>` : ""}
</div>`;
  }).join("\n");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title(rows, names))}</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#1f2328;background:#fff}
h1{font-size:20px;margin-bottom:4px}.sub{color:#656d76;font-size:13px;margin-bottom:20px}
.card{border:1px solid #d0d7de;border-left:4px solid #0969da;border-radius:8px;padding:12px 14px;margin-bottom:12px;break-inside:avoid}
.card.zh{border-left-color:#cf222e}.card.flag{border-color:#bf8700;background:#fff8c5}
.meta{font-size:12px;color:#656d76;margin-bottom:6px}.v{float:right}
.said{font-size:16px;margin-bottom:6px}.tr{font-size:16px;color:#0550ae;margin-bottom:4px}
.cn{font-family:"PingFang SC","Noto Sans SC",sans-serif;font-size:18px}
.small{font-size:12px;color:#656d76;margin-top:3px}.i{font-style:italic}.warn{color:#9a6700}
</style></head><body>
<h1>${escapeHtml(title(rows, names))}</h1>
<div class="sub">${rows.length} exchanges · exported ${escapeHtml(new Date().toLocaleString())}</div>
${cards}
</body></html>`;
}

/** Share through the iPhone share sheet (Save to Files, Mail, Messages…), or download. */
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

export function exportFilename(entries, names, ext) {
  const first = usable(entries)[0]?.time || new Date().toISOString();
  const safe = s => String(s).replace(/[^\w一-鿿-]+/g, "");
  return `${safe(names.en)}-${safe(names.zh)}-${first.slice(0, 10)}.${ext}`;
}
