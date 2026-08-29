export const PROVIDER_DISCLOSURE_VERSION = "2026-08-29.v1";

export const PROVIDER_DISCLOSURE = Object.freeze({
  version: PROVIDER_DISCLOSURE_VERSION,
  title: "Share meeting context with OpenAI?",
  summary: "Selecting OpenAI or importing a key sends nothing. Later, only when you approve an assistance request, finalized transcript excerpts and your question will be sent to OpenAI. Audio, drafts, and unconfirmed text are never sent. OpenAI API usage may be billed separately.",
  links: Object.freeze([
    Object.freeze({ id: "privacy", label: "Privacy" }),
    Object.freeze({ id: "data-controls", label: "Data controls" }),
    Object.freeze({ id: "usage", label: "Usage" })
  ])
});

export const PROVIDER_EXTERNAL_LINKS = Object.freeze({
  privacy: "https://openai.com/policies/privacy-policy/",
  "data-controls": "https://developers.openai.com/api/docs/guides/your-data",
  usage: "https://platform.openai.com/usage"
});

export const PROVIDER_MODES = Object.freeze(["off", "openai", "local"]);
export const AVAILABLE_PROVIDER_MODES = Object.freeze(["off", "openai"]);
export const DEFAULT_PROVIDER_MODE = "off";

export const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
export const OPENAI_MODEL_IDS = Object.freeze(["gpt-5.6-luna"]);
export const DEFAULT_OPENAI_MODEL_ID = "gpt-5.6-luna";

export const PROVIDER_LIMITS = Object.freeze({
  maxContextBytes: 65_536,
  maxQuestionBytes: 2_048,
  maxResponseBytes: 262_144,
  maxOutputTextBytes: 32_768,
  maxOutputTokens: 512,
  requestTimeoutMs: 20_000,
  minRequestIntervalMs: 5_000,
  maxRequestsPerSession: 6,
  maxStoredSegments: 1_024,
  maxSegmentBytes: 8_192,
  maxSessionIdBytes: 256
});

const MODE_SET = new Set(PROVIDER_MODES);
const AVAILABLE_MODE_SET = new Set(AVAILABLE_PROVIDER_MODES);
const MODEL_SET = new Set(OPENAI_MODEL_IDS);

export class ProviderPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderPolicyError";
    this.code = code;
  }
}

export function getProviderCatalog() {
  return Object.freeze({
    defaultMode: DEFAULT_PROVIDER_MODE,
    defaultOpenAIModel: DEFAULT_OPENAI_MODEL_ID,
    modes: Object.freeze([
      Object.freeze({ id: "off", label: "Off", available: true }),
      Object.freeze({ id: "openai", label: "OpenAI API", available: true }),
      Object.freeze({ id: "local", label: "Local model", available: false })
    ]),
    openAIModels: Object.freeze(OPENAI_MODEL_IDS.map((id) => Object.freeze({
      id,
      label: id === DEFAULT_OPENAI_MODEL_ID ? "GPT-5.6 Luna" : id
    }))),
    disclosure: PROVIDER_DISCLOSURE,
    limits: PROVIDER_LIMITS
  });
}

export function sanitizeStoredProviderSettings(value) {
  const input = isRecord(value) ? value : {};
  const mode = AVAILABLE_MODE_SET.has(input.providerMode)
    ? input.providerMode
    : DEFAULT_PROVIDER_MODE;
  const model = MODEL_SET.has(input.openAIModel)
    ? input.openAIModel
    : DEFAULT_OPENAI_MODEL_ID;
  return Object.freeze({ providerMode: mode, openAIModel: model });
}

export function assertAvailableProviderMode(value) {
  if (!MODE_SET.has(value)) {
    throw new ProviderPolicyError("invalid_provider_mode", "The selected assistance provider is invalid.");
  }
  if (!AVAILABLE_MODE_SET.has(value)) {
    throw new ProviderPolicyError("provider_unavailable", "The selected assistance provider is not available yet.");
  }
  return value;
}

export function assertOpenAIModel(value) {
  if (!MODEL_SET.has(value)) {
    throw new ProviderPolicyError("invalid_provider_model", "The selected assistance model is invalid.");
  }
  return value;
}

export function resolveProviderExternalLink(value) {
  if (typeof value !== "string" || !Object.hasOwn(PROVIDER_EXTERNAL_LINKS, value)) {
    throw new ProviderPolicyError("invalid_provider_link", "The selected provider link is invalid.");
  }
  return PROVIDER_EXTERNAL_LINKS[value];
}

export function normalizeSessionId(value) {
  if (typeof value !== "string") {
    throw new ProviderPolicyError("invalid_session", "The assistance session is invalid.");
  }
  const sessionId = value.trim();
  if (sessionId.length === 0
    || Buffer.byteLength(sessionId, "utf8") > PROVIDER_LIMITS.maxSessionIdBytes
    || containsUnsafeControl(sessionId)) {
    throw new ProviderPolicyError("invalid_session", "The assistance session is invalid.");
  }
  return sessionId;
}

export function normalizeAssistQuestion(value) {
  if (typeof value !== "string") {
    throw new ProviderPolicyError("invalid_question", "Enter a question before requesting assistance.");
  }
  const question = value.trim();
  if (question.length === 0) {
    throw new ProviderPolicyError("invalid_question", "Enter a question before requesting assistance.");
  }
  if (Buffer.byteLength(question, "utf8") > PROVIDER_LIMITS.maxQuestionBytes
    || containsUnsafeControl(question)) {
    throw new ProviderPolicyError("question_too_large", "The assistance question is too long.");
  }
  return question;
}

export function normalizeFinalSegment(value) {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const text = value.text.trim();
  if (text.length === 0 || containsUnsafeControl(text)) return null;

  const boundedText = truncateUtf8(text, PROVIDER_LIMITS.maxSegmentBytes);
  const speaker = normalizeSpeaker(value.speaker ?? value.speakerLabel ?? value.speaker_id);
  const startMs = normalizeTimestamp(value.startMs ?? value.start_ms);
  const endMs = normalizeTimestamp(value.endMs ?? value.end_ms);

  return Object.freeze({
    speaker,
    text: boundedText,
    ...(startMs === null ? {} : { startMs }),
    ...(endMs === null ? {} : { endMs })
  });
}

export function buildTranscriptContext(segments) {
  if (!Array.isArray(segments)) return "[]";
  const selected = [];
  let serialized = "[]";

  // Keep the most recent finalized context. Re-serializing a maximum of 1,024
  // small records is deliberate: it enforces the exact UTF-8 wire bound rather
  // than relying on an approximate character count.
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = normalizeFinalSegment(segments[index]);
    if (!segment) continue;
    selected.unshift(segment);
    const candidate = JSON.stringify(selected);
    if (Buffer.byteLength(candidate, "utf8") > PROVIDER_LIMITS.maxContextBytes) {
      selected.shift();
      break;
    }
    serialized = candidate;
  }

  return serialized;
}

export function truncateUtf8(value, maxBytes) {
  if (typeof value !== "string" || maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const buffer = Buffer.from(value, "utf8");
  let end = Math.min(maxBytes, buffer.length);
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function normalizeSpeaker(value) {
  if (typeof value !== "string") return "Unknown speaker";
  const speaker = value.trim();
  if (speaker.length === 0 || containsUnsafeControl(speaker)) return "Unknown speaker";
  return truncateUtf8(speaker, 128);
}

function normalizeTimestamp(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function containsUnsafeControl(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
