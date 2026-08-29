export const ASSIST_CONTEXT_LIMITS = Object.freeze({
  maxFinalSegments: 48,
  maxAgeMs: 15 * 60 * 1_000,
  maxTranscriptChars: 12_000
});

export class AssistContextBuffer {
  constructor({
    maxFinalSegments = ASSIST_CONTEXT_LIMITS.maxFinalSegments,
    maxAgeMs = ASSIST_CONTEXT_LIMITS.maxAgeMs,
    maxTranscriptChars = ASSIST_CONTEXT_LIMITS.maxTranscriptChars
  } = {}) {
    assertPositiveInteger(maxFinalSegments, "maxFinalSegments");
    assertPositiveInteger(maxAgeMs, "maxAgeMs");
    assertPositiveInteger(maxTranscriptChars, "maxTranscriptChars");

    this.limits = Object.freeze({ maxFinalSegments, maxAgeMs, maxTranscriptChars });
    this.sessionId = null;
    this.revision = 0;
    this.segments = new Map();
  }

  startSession(value) {
    const sessionId = normalizeIdentifier(value, "session ID");
    this.sessionId = sessionId;
    this.revision = 0;
    this.segments.clear();
    return Object.freeze({ sessionId, revision: 0 });
  }

  endSession(value = this.sessionId) {
    if (this.sessionId === null) return false;
    if (value !== this.sessionId) return false;
    this.clear();
    return true;
  }

  clear() {
    this.sessionId = null;
    this.revision = 0;
    this.segments.clear();
  }

  ingest(value) {
    if (this.sessionId === null || !isRecord(value)) return false;
    if (value.type !== "final_segment" || value.session_id !== this.sessionId) return false;

    const incoming = cloneFinalSegment(value.segment);
    if (!incoming) return false;

    const current = this.segments.get(incoming.id);
    if (current && incoming.revision <= current.revision) return false;

    this.segments.set(incoming.id, incoming);
    this.revision += 1;
    return Object.freeze({ sessionId: this.sessionId, revision: this.revision });
  }

  snapshot() {
    if (this.sessionId === null) return null;

    const chronological = [...this.segments.values()].sort(compareSegments);
    const latestEndMs = chronological.reduce(
      (latest, segment) => Math.max(latest, segment.end_ms),
      0
    );
    const cutoffMs = Math.max(0, latestEndMs - this.limits.maxAgeMs);
    const recent = chronological.filter((segment) => segment.end_ms >= cutoffMs);

    const selected = [];
    let transcriptChars = 0;
    for (let index = recent.length - 1; index >= 0; index -= 1) {
      if (selected.length >= this.limits.maxFinalSegments) break;
      const segment = recent[index];
      if (transcriptChars + segment.text.length > this.limits.maxTranscriptChars) continue;
      selected.unshift(freezeSegmentClone(segment));
      transcriptChars += segment.text.length;
    }

    return Object.freeze({
      sessionId: this.sessionId,
      revision: this.revision,
      transcriptChars,
      segments: Object.freeze(selected)
    });
  }
}

function cloneFinalSegment(value) {
  if (!isRecord(value)) return null;
  if (value.final !== true || value.partial !== false) return null;
  if (typeof value.text !== "string" || value.text.trim().length === 0) return null;
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  if (!Number.isSafeInteger(value.start_ms) || value.start_ms < 0) return null;
  if (!Number.isSafeInteger(value.end_ms) || value.end_ms < value.start_ms) return null;

  let id;
  try {
    id = normalizeIdentifier(value.id, "segment ID");
  } catch {
    return null;
  }

  return Object.freeze({
    id,
    revision: value.revision,
    start_ms: value.start_ms,
    end_ms: value.end_ms,
    track: value.track === "microphone" ? "microphone" : "system",
    text: value.text,
    language: normalizeOptionalString(value.language),
    speaker_id: normalizeOptionalString(value.speaker_id)
  });
}

function freezeSegmentClone(segment) {
  return Object.freeze({
    id: segment.id,
    revision: segment.revision,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms,
    track: segment.track,
    text: segment.text,
    language: segment.language,
    speaker_id: segment.speaker_id
  });
}

function compareSegments(left, right) {
  return left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.id.localeCompare(right.id);
}

function normalizeIdentifier(value, label) {
  if (typeof value !== "string") throw new TypeError(`Assist ${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256 || containsUnsafeControl(normalized)) {
    throw new TypeError(`Assist ${label} is invalid.`);
  }
  return normalized;
}

function normalizeOptionalString(value) {
  return typeof value === "string" ? value : null;
}

function assertPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function containsUnsafeControl(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}
