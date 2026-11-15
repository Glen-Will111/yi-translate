// Small text helpers shared by the screens and the saved record.

const strip = s => String(s || "").replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();

/** True when two lines differ in their words, not merely in punctuation or spacing. */
export const wordsDiffer = (a, b) => !!a && !!b && strip(a) !== strip(b);
