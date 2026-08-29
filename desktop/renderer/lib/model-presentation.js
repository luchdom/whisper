const MODEL_COUNT = 14;
const TIER_ORDER = Object.freeze(["very_light", "light", "balanced", "high", "very_high"]);
const TIER_LABELS = Object.freeze({
  very_light: "Very light",
  light: "Light",
  balanced: "Balanced",
  high: "High",
  very_high: "Very high"
});
const LANGUAGE_MODES = new Set(["multilingual", "english_only"]);

export function sanitizeCatalogDto(value) {
  if (!isRecord(value) || !hasExactKeys(value, ["defaultModelId", "models", "translation"])) return null;
  if (value.defaultModelId !== "small" || !Array.isArray(value.models) || value.models.length !== MODEL_COUNT) return null;

  const ids = new Set();
  let previousTier = -1;
  const seenTiers = new Set();
  const models = [];
  for (const candidate of value.models) {
    if (!isRecord(candidate) || !hasExactKeys(candidate, [
      "id", "label", "tier", "languageMode", "downloadBytes", "helper"
    ])) return null;
    if (!safeId(candidate.id) || ids.has(candidate.id.toLocaleLowerCase("en-US"))) return null;
    ids.add(candidate.id.toLocaleLowerCase("en-US"));
    if (!safeText(candidate.label, 120) || !safeText(candidate.helper, 220)) return null;
    const tierIndex = TIER_ORDER.indexOf(candidate.tier);
    if (tierIndex < 0 || tierIndex < previousTier) return null;
    previousTier = tierIndex;
    seenTiers.add(candidate.tier);
    if (!LANGUAGE_MODES.has(candidate.languageMode)) return null;
    if (!Number.isSafeInteger(candidate.downloadBytes) || candidate.downloadBytes < 1) return null;
    models.push(Object.freeze({
      id: candidate.id,
      label: candidate.label,
      tier: candidate.tier,
      languageMode: candidate.languageMode,
      downloadBytes: candidate.downloadBytes,
      helper: candidate.helper
    }));
  }
  if (!ids.has(value.defaultModelId) || seenTiers.size !== TIER_ORDER.length) return null;

  const translation = value.translation;
  if (!isRecord(translation) || !hasExactKeys(translation, ["mode", "label", "downloadBytes", "available"])) return null;
  if (
    translation.mode !== "en_to_pt_br"
    || !safeText(translation.label, 120)
    || !Number.isSafeInteger(translation.downloadBytes)
    || translation.downloadBytes < 1
    || typeof translation.available !== "boolean"
  ) return null;

  return deepFreeze({
    defaultModelId: value.defaultModelId,
    models,
    translation: {
      mode: translation.mode,
      label: translation.label,
      downloadBytes: translation.downloadBytes,
      available: translation.available
    }
  });
}

export function groupCatalogModels(catalog) {
  return TIER_ORDER
    .map((tier) => Object.freeze({
      tier,
      label: TIER_LABELS[tier],
      models: Object.freeze(catalog.models.filter((model) => model.tier === tier))
    }))
    .filter(({ models }) => models.length > 0);
}

export function getTierLabel(tier) {
  return TIER_LABELS[tier] ?? "Local model";
}

export function formatDownloadBytes(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) return "Unknown size";
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2).replace(/\.0+$|(?<=\.[0-9])0$/, "")} GB`;
}

export function getEffectiveLanguage(model, savedLanguage) {
  return model?.languageMode === "english_only" ? "en" : savedLanguage;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeId(value) {
  return typeof value === "string" && /^[a-z0-9](?:[a-z0-9.-]{0,63})$/.test(value);
}

function safeText(value, maxLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && value === value.trim()
    && !/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function deepFreeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) deepFreeze(child);
  }
  return Object.freeze(value);
}
