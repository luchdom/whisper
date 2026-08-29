export const DEBRIEF_MAX_ITEM_TEXT_CHARS = 2_000;

export function normalizeDebriefText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function boundDebriefExtractText(value) {
  const normalized = normalizeDebriefText(value);
  if (normalized.length <= DEBRIEF_MAX_ITEM_TEXT_CHARS) return normalized;
  return `${normalized.slice(0, DEBRIEF_MAX_ITEM_TEXT_CHARS - 1).trimEnd()}…`;
}

export function isDebriefExtractDerivedFromOriginal(extractText, originalText) {
  if (typeof extractText !== "string" || typeof originalText !== "string") return false;
  const extract = normalizeDebriefText(extractText);
  const original = normalizeDebriefText(originalText);
  if (!extract || !original) return false;
  if (original.includes(extract)) return true;
  if (!extract.endsWith("…")) return false;

  // The local extractor adds one ellipsis only when it reaches the fixed
  // 2,000-character display bound. Verify that exact normalized prefix and
  // require additional original text after it so a renderer-authored short
  // ellipsis cannot impersonate a truncated local extract.
  if (extract.length < DEBRIEF_MAX_ITEM_TEXT_CHARS - 1
    || extract.length > DEBRIEF_MAX_ITEM_TEXT_CHARS) {
    return false;
  }
  const prefix = extract.slice(0, -1).trimEnd();
  const matchIndex = original.indexOf(prefix);
  return matchIndex >= 0 && original.length > matchIndex + prefix.length;
}
