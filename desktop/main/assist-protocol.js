export const ASSIST_CHANNELS = Object.freeze([
  "suggestion",
  "supporting_point",
  "follow_up_question",
  "caveat"
]);

export const ASSIST_LIMITS = Object.freeze({
  maxQuestionChars: 1_000,
  maxProviderDeltaChars: 4_000,
  maxProviderItemChars: 8_000,
  maxOutputChars: 12_000,
  maxCitationsPerItem: 24,
  maxIdentifierChars: 256
});

const CHANNEL_SET = new Set(ASSIST_CHANNELS);
const OUTBOUND_TYPES = new Set([
  "assist_started",
  "assist_delta",
  "assist_item",
  "assist_completed",
  "assist_error",
  "assist_canceled"
]);
const TERMINAL_TYPES = new Set(["assist_completed", "assist_error", "assist_canceled"]);

export class AssistProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AssistProtocolError";
    this.code = code;
  }
}

export function normalizeRendererAssistRequest(value) {
  const input = requireClosedRecord(
    value,
    ["question"],
    "assistance request"
  );
  return Object.freeze({
    question: requireBoundedText(input.question, "question", ASSIST_LIMITS.maxQuestionChars)
  });
}

export function normalizeProviderAssistEvent(value, validSegmentIds) {
  const input = requireRecord(value, "provider event");
  const allowedCitations = normalizeSegmentIdSet(validSegmentIds);

  if (input.type === "delta") {
    requireExactKeys(input, ["type", "channel", "delta"], "provider delta");
    return Object.freeze({
      type: "assist_delta",
      channel: requireChannel(input.channel),
      delta: requireBoundedText(input.delta, "provider delta", ASSIST_LIMITS.maxProviderDeltaChars, {
        trim: false,
        allowWhitespace: true
      })
    });
  }

  if (input.type === "item") {
    requireExactKeys(input, ["type", "channel", "text", "citations"], "provider item");
    const citations = normalizeCitations(input.citations, allowedCitations);
    return Object.freeze({
      type: "assist_item",
      channel: requireChannel(input.channel),
      text: requireBoundedText(input.text, "provider item", ASSIST_LIMITS.maxProviderItemChars),
      citations
    });
  }

  throw new AssistProtocolError(
    "invalid_provider_event",
    "The assistance provider returned an invalid event."
  );
}

export function createAssistEvent(metadata, payload) {
  const envelope = requireClosedRecord(
    metadata,
    ["requestId", "sessionId", "contextRevision", "sequence"],
    "event metadata"
  );
  const body = requireRecord(payload, "event payload");
  return validateAssistEvent({ ...envelope, ...body });
}

export function validateAssistEvent(value, { expectedSequence } = {}) {
  const event = requireRecord(value, "assistance event");
  if (!OUTBOUND_TYPES.has(event.type)) {
    throw new AssistProtocolError("invalid_assist_event", "The assistance event is invalid.");
  }

  const base = {
    type: event.type,
    requestId: requireIdentifier(event.requestId, "request ID"),
    sessionId: requireIdentifier(event.sessionId, "session ID"),
    contextRevision: requireNonNegativeInteger(event.contextRevision, "context revision"),
    sequence: requirePositiveInteger(event.sequence, "event sequence")
  };
  if (expectedSequence !== undefined && base.sequence !== expectedSequence) {
    throw new AssistProtocolError("invalid_event_sequence", "The assistance event is out of order.");
  }

  if (event.type === "assist_started") {
    requireExactKeys(event, [...Object.keys(base)], "started event");
    return Object.freeze(base);
  }
  if (event.type === "assist_delta") {
    requireExactKeys(event, [...Object.keys(base), "channel", "delta"], "delta event");
    return Object.freeze({
      ...base,
      channel: requireChannel(event.channel),
      delta: requireBoundedText(event.delta, "assistance delta", ASSIST_LIMITS.maxProviderDeltaChars, {
        trim: false,
        allowWhitespace: true
      })
    });
  }
  if (event.type === "assist_item") {
    requireExactKeys(event, [...Object.keys(base), "channel", "text", "citations"], "item event");
    return Object.freeze({
      ...base,
      channel: requireChannel(event.channel),
      text: requireBoundedText(event.text, "assistance item", ASSIST_LIMITS.maxProviderItemChars),
      citations: normalizeLooseCitations(event.citations)
    });
  }
  if (event.type === "assist_completed") {
    requireExactKeys(event, [...Object.keys(base), "metrics"], "completed event");
    return Object.freeze({ ...base, metrics: normalizeMetrics(event.metrics) });
  }
  if (event.type === "assist_error") {
    requireExactKeys(event, [...Object.keys(base), "error"], "error event");
    return Object.freeze({ ...base, error: normalizePublicError(event.error) });
  }

  requireExactKeys(event, [...Object.keys(base), "reason"], "canceled event");
  if (!["canceled", "superseded", "session_reset"].includes(event.reason)) {
    throw new AssistProtocolError("invalid_cancel_reason", "The cancellation reason is invalid.");
  }
  return Object.freeze({ ...base, reason: event.reason });
}

export function isTerminalAssistEvent(value) {
  return TERMINAL_TYPES.has(value?.type);
}

export function sanitizeAssistError(error) {
  const known = new Map([
    ["provider_timeout", ["The assistance request timed out.", true]],
    ["provider_authentication_failed", ["The assistance provider rejected the saved credential.", false]],
    ["provider_rate_limited", ["The assistance provider is rate limiting requests.", true]],
    ["provider_unavailable", ["The assistance provider is temporarily unavailable.", true]],
    ["provider_network_error", ["The assistance provider could not be reached.", true]],
    ["provider_output_too_large", ["The assistance response exceeded the local safety limit.", false]],
    ["provider_protocol_error", ["The assistance provider returned an invalid response.", false]],
    ["provider_request_aborted", ["The assistance request was canceled.", false]]
  ]);
  const entry = known.get(error?.code);
  if (entry) {
    return Object.freeze({ code: error.code, message: entry[0], retryable: entry[1] });
  }
  return Object.freeze({
    code: "provider_failure",
    message: "Assistance failed without affecting transcription.",
    retryable: false
  });
}

function normalizePublicError(value) {
  const input = requireClosedRecord(value, ["code", "message", "retryable"], "public error");
  if (typeof input.retryable !== "boolean") {
    throw new AssistProtocolError("invalid_assist_event", "The assistance error is invalid.");
  }
  return Object.freeze({
    code: requireSafeCode(input.code),
    message: requireBoundedText(input.message, "error message", 240),
    retryable: input.retryable
  });
}

function normalizeMetrics(value) {
  const input = requireClosedRecord(
    value,
    ["timeToFirstTokenMs", "totalMs", "outputChars"],
    "completion metrics"
  );
  const timeToFirstTokenMs = input.timeToFirstTokenMs === null
    ? null
    : requireNonNegativeInteger(input.timeToFirstTokenMs, "time to first token");
  return Object.freeze({
    timeToFirstTokenMs,
    totalMs: requireNonNegativeInteger(input.totalMs, "total time"),
    outputChars: requireNonNegativeInteger(input.outputChars, "output characters")
  });
}

function normalizeCitations(value, allowed) {
  if (!Array.isArray(value) || value.length > ASSIST_LIMITS.maxCitationsPerItem) {
    throw new AssistProtocolError("invalid_provider_event", "The assistance provider returned invalid citations.");
  }
  const unique = [];
  const seen = new Set();
  for (const entry of value) {
    const id = requireIdentifier(entry, "citation segment ID");
    if (!allowed.has(id)) {
      throw new AssistProtocolError("invalid_provider_citation", "The assistance provider cited unknown transcript context.");
    }
    if (!seen.has(id)) {
      seen.add(id);
      unique.push(id);
    }
  }
  return Object.freeze(unique);
}

function normalizeLooseCitations(value) {
  if (!Array.isArray(value) || value.length > ASSIST_LIMITS.maxCitationsPerItem) {
    throw new AssistProtocolError("invalid_assist_event", "The assistance citations are invalid.");
  }
  return Object.freeze(value.map((entry) => requireIdentifier(entry, "citation segment ID")));
}

function normalizeSegmentIdSet(value) {
  if (value instanceof Set) return new Set([...value].map((entry) => requireIdentifier(entry, "segment ID")));
  if (Array.isArray(value)) return new Set(value.map((entry) => requireIdentifier(entry, "segment ID")));
  throw new AssistProtocolError("invalid_context", "Valid transcript segment IDs are required.");
}

function requireBoundedText(value, label, maxChars, { trim = true, allowWhitespace = false } = {}) {
  if (typeof value !== "string") {
    throw new AssistProtocolError("invalid_assist_request", `The ${label} must be text.`);
  }
  const normalized = trim ? value.trim() : value;
  const empty = allowWhitespace ? normalized.length === 0 : normalized.trim().length === 0;
  if (empty || normalized.length > maxChars || containsUnsafeControl(normalized)) {
    throw new AssistProtocolError("invalid_assist_request", `The ${label} is empty or too long.`);
  }
  return normalized;
}

function requireChannel(value) {
  if (!CHANNEL_SET.has(value)) {
    throw new AssistProtocolError("invalid_provider_channel", "The assistance provider returned an invalid channel.");
  }
  return value;
}

function requireIdentifier(value, label) {
  if (typeof value !== "string") {
    throw new AssistProtocolError("invalid_identifier", `The ${label} is invalid.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0
    || normalized.length > ASSIST_LIMITS.maxIdentifierChars
    || containsUnsafeControl(normalized)) {
    throw new AssistProtocolError("invalid_identifier", `The ${label} is invalid.`);
  }
  return normalized;
}

function requireSafeCode(value) {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{1,63}$/u.test(value)) {
    throw new AssistProtocolError("invalid_assist_event", "The assistance error code is invalid.");
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AssistProtocolError("invalid_assist_event", `The ${label} is invalid.`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AssistProtocolError("invalid_assist_event", `The ${label} is invalid.`);
  }
  return value;
}

function requireClosedRecord(value, allowedKeys, label) {
  const input = requireRecord(value, label);
  requireAllowedKeys(input, allowedKeys, label);
  return input;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AssistProtocolError("invalid_assist_request", `The ${label} must be an object.`);
  }
  return value;
}

function requireAllowedKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new AssistProtocolError("unexpected_assist_field", `The ${label} contains an unexpected field.`);
    }
  }
}

function requireExactKeys(value, exactKeys, label) {
  requireAllowedKeys(value, exactKeys, label);
  for (const key of exactKeys) {
    if (!(key in value)) {
      throw new AssistProtocolError("invalid_assist_event", `The ${label} is missing a field.`);
    }
  }
}

function containsUnsafeControl(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
