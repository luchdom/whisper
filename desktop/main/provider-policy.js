export const PROVIDER_DISCLOSURE_VERSION = "2026-08-29.v3";

export const PROVIDER_DISCLOSURE = Object.freeze({
  version: PROVIDER_DISCLOSURE_VERSION,
  title: "Share meeting context with OpenAI?",
  summary: "Selecting OpenAI, choosing a meeting profile, editing private context, or importing a key sends nothing. Each Send shares only your question, the shown built-in profile, the private context packs you selected for this meeting, and finalized transcript text with anonymous speaker labels and timestamps. Audio, draft transcript text, translations, unselected packs, and manual speaker names are never sent. Your API key stays out of the renderer and context pack; the main process uses it only to authenticate this OpenAI HTTPS request. OpenAI API usage may be billed separately.",
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
  maxQuestionBytes: 4_000,
  maxResponseBytes: 262_144,
  maxOutputTextBytes: 32_768,
  maxOutputTokens: 512,
  requestTimeoutMs: 20_000,
  minRequestIntervalMs: 5_000,
  maxRequestsPerSession: 6,
  maxStoredSegments: 1_024,
  maxSegmentBytes: 8_192,
  maxSessionIdBytes: 256,
  maxContextPacks: 12,
  maxContextPackBytes: 64 * 1_024,
  maxProfileFieldBytes: 4_096
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

export function normalizeProviderContextSnapshot(value, { expectedSessionId } = {}) {
  requireFrozenRecord(value, "context snapshot");
  const baseKeys = ["sessionId", "revision", "transcriptChars", "segments"];
  const extended = hasExactKeys(value, [...baseKeys, "profile", "contextPacks"]);
  if (!extended) requireExactKeys(value, baseKeys, "context snapshot");
  const sessionId = normalizeSessionId(value.sessionId);
  if (expectedSessionId !== undefined && sessionId !== normalizeSessionId(expectedSessionId)) {
    throw new ProviderPolicyError("invalid_session", "The assistance context belongs to another meeting.");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new ProviderPolicyError("invalid_context", "The assistance context revision is invalid.");
  }
  if (!Number.isSafeInteger(value.transcriptChars)
    || value.transcriptChars < 0
    || value.transcriptChars > 12_000) {
    throw new ProviderPolicyError("invalid_context", "The assistance context size is invalid.");
  }
  if (!Array.isArray(value.segments) || !Object.isFrozen(value.segments) || value.segments.length > 48) {
    throw new ProviderPolicyError("invalid_context", "The assistance context segments are invalid.");
  }

  const segments = [];
  const ids = new Set();
  let transcriptChars = 0;
  let previous = null;
  for (const rawSegment of value.segments) {
    const segment = normalizeSnapshotSegment(rawSegment);
    if (ids.has(segment.id)) {
      throw new ProviderPolicyError("invalid_context", "The assistance context contains a duplicate segment.");
    }
    if (previous && compareSnapshotSegments(previous, segment) > 0) {
      throw new ProviderPolicyError("invalid_context", "The assistance context is not chronological.");
    }
    ids.add(segment.id);
    transcriptChars += segment.text.length;
    previous = segment;
    segments.push(segment);
  }
  if (transcriptChars !== value.transcriptChars) {
    throw new ProviderPolicyError("invalid_context", "The assistance context size does not match its content.");
  }

  const normalized = {
    sessionId,
    revision: value.revision,
    transcriptChars,
    segments: Object.freeze(segments)
  };
  if (extended) {
    const sessionContext = normalizeAssistSessionContext({
      profile: value.profile,
      contextPacks: value.contextPacks
    });
    normalized.profile = sessionContext.profile;
    normalized.contextPacks = sessionContext.contextPacks;
  }
  return Object.freeze(normalized);
}

export function createAssistSessionContext({ profile, contextPacks = [] } = {}) {
  return normalizeAssistSessionContext({ profile, contextPacks });
}

export function normalizeAssistSessionContext(value) {
  if (!isRecord(value)) {
    throw new ProviderPolicyError("invalid_context", "The selected meeting context is invalid.");
  }
  const profile = normalizeMeetingProfileContext(value.profile);
  if (!Array.isArray(value.contextPacks)
    || value.contextPacks.length > PROVIDER_LIMITS.maxContextPacks) {
    throw new ProviderPolicyError("invalid_context", "The selected private context packs are invalid.");
  }
  const allowedKinds = new Set(profile.allowedContextKinds);
  const ids = new Set();
  const packs = value.contextPacks.map((candidate) => {
    const pack = normalizePrivateContextPack(candidate);
    if (ids.has(pack.id) || !allowedKinds.has(pack.kind)) {
      throw new ProviderPolicyError(
        "invalid_context",
        "A selected private context pack is duplicated or unavailable for this meeting profile."
      );
    }
    ids.add(pack.id);
    return pack;
  });
  return Object.freeze({ profile, contextPacks: Object.freeze(packs) });
}

export function buildTranscriptContext(segments) {
  if (isRecord(segments) && Object.hasOwn(segments, "segments")) {
    const snapshot = normalizeProviderContextSnapshot(segments);
    const serialized = JSON.stringify(toProviderContext(snapshot));
    if (Buffer.byteLength(serialized, "utf8") > PROVIDER_LIMITS.maxContextBytes) {
      throw new ProviderPolicyError("provider_context_too_large", "The assistance context is too large.");
    }
    return serialized;
  }
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

export function buildProviderContextPreview(value) {
  const snapshot = normalizeProviderContextSnapshot(value);
  const providerContext = toProviderContext(snapshot);
  const serialized = JSON.stringify(providerContext);
  const totalBytes = Buffer.byteLength(serialized, "utf8");
  if (totalBytes > PROVIDER_LIMITS.maxContextBytes) {
    throw new ProviderPolicyError("provider_context_too_large", "The assistance context is too large.");
  }
  const transcript = snapshot.segments.map(toProviderSegment);
  const profile = snapshot.profile ? toProviderProfile(snapshot.profile) : null;
  const contextPacks = snapshot.contextPacks?.map(toProviderContextPack) ?? [];
  return Object.freeze({
    totalBytes,
    maxBytes: PROVIDER_LIMITS.maxContextBytes,
    profile: profile
      ? Object.freeze({
          name: profile.name,
          version: profile.version,
          bytes: Buffer.byteLength(JSON.stringify(profile), "utf8")
        })
      : null,
    contextPacks: Object.freeze(contextPacks.map((pack) => Object.freeze({
      category: pack.category,
      name: pack.name,
      bytes: Buffer.byteLength(JSON.stringify(pack), "utf8")
    }))),
    transcript: Object.freeze({
      segmentCount: transcript.length,
      bytes: Buffer.byteLength(JSON.stringify(transcript), "utf8"),
      startMs: transcript[0]?.startMs ?? null,
      endMs: transcript.at(-1)?.endMs ?? null
    })
  });
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

function normalizeSnapshotSegment(value) {
  requireFrozenRecord(value, "context segment");
  requireExactKeys(
    value,
    ["id", "revision", "start_ms", "end_ms", "track", "text", "language", "speaker_id"],
    "context segment"
  );
  if (typeof value.id !== "string"
    || value.id.trim().length === 0
    || value.id.length > 256
    || containsUnsafeControl(value.id)) {
    throw new ProviderPolicyError("invalid_context", "The assistance context segment ID is invalid.");
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0
    || !Number.isSafeInteger(value.start_ms) || value.start_ms < 0
    || !Number.isSafeInteger(value.end_ms) || value.end_ms < value.start_ms) {
    throw new ProviderPolicyError("invalid_context", "The assistance context segment timing is invalid.");
  }
  if (!['system', 'microphone'].includes(value.track)) {
    throw new ProviderPolicyError("invalid_context", "The assistance context track is invalid.");
  }
  if (typeof value.text !== "string"
    || value.text.trim().length === 0
    || containsUnsafeControl(value.text)) {
    throw new ProviderPolicyError("invalid_context", "The assistance context text is invalid.");
  }

  return Object.freeze({
    id: value.id,
    revision: value.revision,
    start_ms: value.start_ms,
    end_ms: value.end_ms,
    track: value.track,
    text: value.text,
    language: normalizeSnapshotOptionalString(value.language, "language", 64),
    speaker_id: normalizeSnapshotOptionalString(value.speaker_id, "speaker label", 256)
  });
}

function normalizeSnapshotOptionalString(value, label, maxLength) {
  if (value === null) return null;
  if (typeof value !== "string"
    || value.length > maxLength
    || containsUnsafeControl(value)) {
    throw new ProviderPolicyError("invalid_context", `The assistance context ${label} is invalid.`);
  }
  return value;
}

function normalizeMeetingProfileContext(value) {
  if (!isRecord(value)) {
    throw new ProviderPolicyError("invalid_context", "The selected meeting profile is invalid.");
  }
  const id = normalizeSafeIdentifier(value.id, "meeting profile ID", 64);
  if (!Number.isSafeInteger(value.version) || value.version <= 0) {
    throw new ProviderPolicyError("invalid_context", "The selected meeting profile version is invalid.");
  }
  const name = normalizeBoundedContextText(value.name, "meeting profile name", 240);
  const responseStyle = normalizeBoundedContextText(
    value.responseStyle,
    "meeting profile response style",
    PROVIDER_LIMITS.maxProfileFieldBytes
  );
  const instruction = normalizeBoundedContextText(
    value.instruction,
    "meeting profile guidance",
    PROVIDER_LIMITS.maxProfileFieldBytes
  );
  if (!Array.isArray(value.allowedContextKinds) || value.allowedContextKinds.length === 0) {
    throw new ProviderPolicyError("invalid_context", "The selected meeting profile categories are invalid.");
  }
  const allowedContextKinds = value.allowedContextKinds.map((kind) => (
    normalizeSafeIdentifier(kind, "meeting profile category", 64)
  ));
  if (new Set(allowedContextKinds).size !== allowedContextKinds.length) {
    throw new ProviderPolicyError("invalid_context", "The selected meeting profile categories are invalid.");
  }
  if (!Array.isArray(value.limitations) || value.limitations.length === 0 || value.limitations.length > 8) {
    throw new ProviderPolicyError("invalid_context", "The selected meeting profile limitations are invalid.");
  }
  const limitations = value.limitations.map((limitation) => normalizeBoundedContextText(
    limitation,
    "meeting profile limitation",
    PROVIDER_LIMITS.maxProfileFieldBytes
  ));
  return Object.freeze({
    id,
    version: value.version,
    name,
    responseStyle,
    allowedContextKinds: Object.freeze(allowedContextKinds),
    limitations: Object.freeze(limitations),
    instruction
  });
}

function normalizePrivateContextPack(value) {
  if (!isRecord(value)) {
    throw new ProviderPolicyError("invalid_context", "A selected private context pack is invalid.");
  }
  const id = normalizeSafeIdentifier(value.id, "private context pack ID", 64);
  if (!Number.isSafeInteger(value.revision) || value.revision <= 0) {
    throw new ProviderPolicyError("invalid_context", "A selected private context pack revision is invalid.");
  }
  const kind = normalizeSafeIdentifier(value.kind, "private context category", 64);
  const name = normalizeBoundedContextText(value.name, "private context pack name", 240);
  const content = preserveBoundedContextText(
    value.content,
    "private context pack content",
    PROVIDER_LIMITS.maxContextPackBytes
  );
  return Object.freeze({ id, revision: value.revision, kind, name, content });
}

function normalizeSafeIdentifier(value, label, maxBytes) {
  if (typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes
    || !/^[a-z0-9][a-z0-9_-]*$/u.test(value)
    || containsUnsafeControl(value)) {
    throw new ProviderPolicyError("invalid_context", `The ${label} is invalid.`);
  }
  return value;
}

function normalizeBoundedContextText(value, label, maxBytes) {
  if (typeof value !== "string") {
    throw new ProviderPolicyError("invalid_context", `The ${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0
    || Buffer.byteLength(normalized, "utf8") > maxBytes
    || containsUnsafeControl(normalized)) {
    throw new ProviderPolicyError("invalid_context", `The ${label} is invalid.`);
  }
  return normalized;
}

function preserveBoundedContextText(value, label, maxBytes) {
  if (typeof value !== "string"
    || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > maxBytes
    || containsUnsafeControl(value)
    || hasUnpairedSurrogate(value)) {
    throw new ProviderPolicyError("invalid_context", `The ${label} is invalid.`);
  }
  return value;
}

function toProviderContext(snapshot) {
  const transcript = snapshot.segments.map(toProviderSegment);
  if (!snapshot.profile) return transcript;
  return Object.freeze({
    meetingProfile: toProviderProfile(snapshot.profile),
    privateContextPacks: Object.freeze(snapshot.contextPacks.map(toProviderContextPack)),
    finalizedTranscript: Object.freeze(transcript)
  });
}

function toProviderProfile(profile) {
  return Object.freeze({
    name: profile.name,
    version: profile.version,
    responseStyle: profile.responseStyle,
    limitations: profile.limitations,
    appGuidance: profile.instruction
  });
}

function toProviderContextPack(pack) {
  return Object.freeze({
    category: pack.kind,
    name: pack.name,
    content: pack.content
  });
}

function toProviderSegment(segment) {
  return Object.freeze({
    startMs: segment.start_ms,
    endMs: segment.end_ms,
    speakerLabel: segment.track === "microphone"
      ? "You"
      : segment.speaker_id || "Meeting audio",
    text: segment.text
  });
}

function hasExactKeys(value, exactKeys) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...exactKeys].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
}

function compareSnapshotSegments(left, right) {
  return left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.id.localeCompare(right.id);
}

function requireFrozenRecord(value, label) {
  if (!isRecord(value) || !Object.isFrozen(value)) {
    throw new ProviderPolicyError("invalid_context", `The assistance ${label} must be frozen.`);
  }
}

function requireExactKeys(value, exactKeys, label) {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...exactKeys].sort();
  if (actualKeys.length !== expectedKeys.length
    || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new ProviderPolicyError("invalid_context", `The assistance ${label} schema is invalid.`);
  }
}

function containsUnsafeControl(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function hasUnpairedSurrogate(value) {
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

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
