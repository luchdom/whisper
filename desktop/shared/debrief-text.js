export const DEBRIEF_MAX_ITEM_TEXT_CHARS = 2_000;

const UNSAFE_DEBRIEF_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

export function containsUnsafeDebriefTextControl(value) {
  return typeof value === "string" && UNSAFE_DEBRIEF_TEXT_CONTROL.test(value);
}

export function hasUnpairedDebriefSurrogate(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

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
