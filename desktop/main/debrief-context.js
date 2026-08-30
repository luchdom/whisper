import {
  containsUnsafeDebriefTextControl,
  hasUnpairedDebriefSurrogate
} from "../shared/debrief-text.js";

export const DEBRIEF_CONTEXT_SCHEMA_VERSION = 1;

export const DEBRIEF_CONTEXT_LIMITS = Object.freeze({
  maxFinalSegments: 4_000,
  maxTranscriptChars: 1_000_000
});

const COMPLETE_STOP_REASON = "stopped";
const TRACKS = new Set(["system", "microphone"]);

export class DebriefContextBuffer {
  constructor({
    maxFinalSegments = DEBRIEF_CONTEXT_LIMITS.maxFinalSegments,
    maxTranscriptChars = DEBRIEF_CONTEXT_LIMITS.maxTranscriptChars
  } = {}) {
    assertPositiveInteger(maxFinalSegments, "maxFinalSegments");
    assertPositiveInteger(maxTranscriptChars, "maxTranscriptChars");

    this.limits = Object.freeze({ maxFinalSegments, maxTranscriptChars });
    this.clear();
  }

  startSession(value) {
    const sessionId = normalizeIdentifier(value, "session ID");
    this.clear();
    this.sessionId = sessionId;
    this.state = "active";
    return Object.freeze({ sessionId, revision: 0, state: "active" });
  }

  ingest(value) {
    if (this.state !== "active" || !isRecord(value)) return false;
    if (value.type !== "final_segment" || value.session_id !== this.sessionId) return false;

    const incoming = cloneFinalSegment(value.segment);
    if (!incoming) return false;

    const current = this.segments.get(incoming.id);
    const omitted = this.omittedRevisions.get(incoming.id);
    const previous = current ?? omitted ?? null;
    if (previous && incoming.revision <= previous.revision) return false;
    if (
      previous === null
      && this.hasUntrackedOmissions
      && incoming.start_ms <= this.untrackedOmissionEndMs
    ) {
      // Once bounded revision tombstones roll over, accepting a historical
      // unknown ID could double-count a late correction as a new segment.
      // Fail closed for that forgotten time range instead.
      return false;
    }

    if (current) {
      this.retainedTranscriptChars += incoming.text.length - current.text.length;
      this.totalTranscriptChars += incoming.text.length - current.text.length;
    } else {
      if (omitted) {
        this.omittedRevisions.delete(incoming.id);
        this.totalTranscriptChars += incoming.text.length - omitted.textLength;
      } else {
        this.totalFinalSegments += 1;
        this.totalTranscriptChars += incoming.text.length;
      }
      this.retainedTranscriptChars += incoming.text.length;
    }

    this.segments.set(incoming.id, incoming);
    this.observedStartMs = this.observedStartMs === null
      ? incoming.start_ms
      : Math.min(this.observedStartMs, incoming.start_ms);
    this.observedEndMs = this.observedEndMs === null
      ? incoming.end_ms
      : Math.max(this.observedEndMs, incoming.end_ms);
    this.#pruneRetainedWindow();
    this.revision += 1;
    return Object.freeze({
      sessionId: this.sessionId,
      revision: this.revision,
      state: this.state
    });
  }

  finalizeSession(value = this.sessionId, options = {}) {
    if (this.state !== "active" || this.sessionId === null) return false;
    if (value !== this.sessionId) return false;
    if (!isRecord(options)) throw new TypeError("Debrief finalization options must be an object.");

    const reason = normalizeReason(
      options.reason ?? (options.complete === true ? COMPLETE_STOP_REASON : "unknown")
    );
    const complete = options.complete === undefined
      ? reason === COMPLETE_STOP_REASON
      : normalizeBoolean(options.complete, "complete");

    this.state = complete ? "complete" : "incomplete";
    this.reason = reason;
    return this.snapshot();
  }

  endSession(value = this.sessionId, options = {}) {
    return this.finalizeSession(value, options);
  }

  clear() {
    this.sessionId = null;
    this.revision = 0;
    this.state = "empty";
    this.reason = null;
    this.segments = new Map();
    this.omittedRevisions = new Map();
    this.retainedTranscriptChars = 0;
    this.totalFinalSegments = 0;
    this.totalTranscriptChars = 0;
    this.observedStartMs = null;
    this.observedEndMs = null;
    this.hasUntrackedOmissions = false;
    this.untrackedOmissionEndMs = -1;
  }

  snapshot() {
    if (this.sessionId === null) return null;

    const selected = [...this.segments.values()].sort(compareSegments);
    const coverage = createCoverage(selected, {
      totalFinalSegments: this.totalFinalSegments,
      totalTranscriptChars: this.totalTranscriptChars,
      observedStartMs: this.observedStartMs,
      observedEndMs: this.observedEndMs
    });

    return Object.freeze({
      schemaVersion: DEBRIEF_CONTEXT_SCHEMA_VERSION,
      sessionId: this.sessionId,
      revision: this.revision,
      state: this.state,
      complete: this.state === "complete",
      reason: this.reason,
      coverage,
      segments: Object.freeze(selected.map(freezeSegmentClone))
    });
  }

  #pruneRetainedWindow() {
    if (
      this.segments.size <= this.limits.maxFinalSegments
      && this.retainedTranscriptChars <= this.limits.maxTranscriptChars
    ) return;

    const chronological = [...this.segments.values()].sort(compareSegments);
    while (
      chronological.length > 0
      && (
        this.segments.size > this.limits.maxFinalSegments
        || this.retainedTranscriptChars > this.limits.maxTranscriptChars
      )
    ) {
      const omitted = chronological.shift();
      this.segments.delete(omitted.id);
      this.retainedTranscriptChars -= omitted.text.length;
      this.#rememberOmittedRevision(omitted);
    }
  }

  #rememberOmittedRevision(segment) {
    this.omittedRevisions.delete(segment.id);
    this.omittedRevisions.set(segment.id, Object.freeze({
      revision: segment.revision,
      textLength: segment.text.length,
      startMs: segment.start_ms,
      endMs: segment.end_ms
    }));
    while (this.omittedRevisions.size > this.limits.maxFinalSegments) {
      const oldestId = this.omittedRevisions.keys().next().value;
      const forgotten = this.omittedRevisions.get(oldestId);
      this.hasUntrackedOmissions = true;
      this.untrackedOmissionEndMs = Math.max(this.untrackedOmissionEndMs, forgotten.endMs);
      this.omittedRevisions.delete(oldestId);
    }
  }
}

function createCoverage(includedSegments, observed) {
  const includedTranscriptChars = sum(includedSegments, ({ text }) => text.length);
  const omittedFinalSegments = observed.totalFinalSegments - includedSegments.length;

  return Object.freeze({
    totalFinalSegments: observed.totalFinalSegments,
    includedFinalSegments: includedSegments.length,
    omittedFinalSegments,
    totalTranscriptChars: observed.totalTranscriptChars,
    includedTranscriptChars,
    truncated: omittedFinalSegments > 0,
    observedStartMs: observed.observedStartMs,
    observedEndMs: observed.observedEndMs,
    includedStartMs: firstStart(includedSegments),
    includedEndMs: lastEnd(includedSegments)
  });
}

function cloneFinalSegment(value) {
  if (!isRecord(value)) return null;
  if (value.final !== true || value.partial !== false) return null;
  if (typeof value.text !== "string"
    || value.text.trim().length === 0
    || value.text.length > 20_000
    || containsUnsafeDebriefTextControl(value.text)
    || hasUnpairedDebriefSurrogate(value.text)) {
    return null;
  }
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return null;
  if (!Number.isSafeInteger(value.start_ms) || value.start_ms < 0) return null;
  if (!Number.isSafeInteger(value.end_ms) || value.end_ms < value.start_ms) return null;
  if (!TRACKS.has(value.track)) return null;

  let id;
  let language;
  let speakerId;
  let translation;
  try {
    id = normalizeIdentifier(value.id, "segment ID");
    language = normalizeOptionalIdentifier(value.language, "segment language", 64);
    speakerId = normalizeOptionalIdentifier(value.speaker_id, "speaker ID", 256);
    translation = normalizeTranslation(value);
  } catch {
    return null;
  }

  return Object.freeze({
    id,
    revision: value.revision,
    start_ms: value.start_ms,
    end_ms: value.end_ms,
    track: value.track,
    text: value.text,
    language,
    speaker_id: speakerId,
    translated_text: translation.text,
    translated_language: translation.language
  });
}

function normalizeTranslation(value) {
  const translatedText = value.translated_text ?? null;
  const translatedLanguage = value.translated_language ?? null;
  if (translatedText === null) {
    if (translatedLanguage !== null) {
      throw new TypeError("Translated language requires translated text.");
    }
    return { text: null, language: null };
  }
  if (typeof translatedText !== "string"
    || translatedText.length > 20_000
    || containsUnsafeDebriefTextControl(translatedText)
    || hasUnpairedDebriefSurrogate(translatedText)) {
    throw new TypeError("Translated text must be bounded.");
  }
  if (translatedLanguage !== "pt-BR") {
    throw new TypeError("Translated language must be pt-BR.");
  }
  return { text: translatedText, language: translatedLanguage };
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
    speaker_id: segment.speaker_id,
    translated_text: segment.translated_text,
    translated_language: segment.translated_language
  });
}

function compareSegments(left, right) {
  return left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.id.localeCompare(right.id);
}

function firstStart(segments) {
  return segments.length > 0 ? segments[0].start_ms : null;
}

function lastEnd(segments) {
  if (segments.length === 0) return null;
  return segments.reduce((latest, segment) => Math.max(latest, segment.end_ms), 0);
}

function sum(values, selector) {
  return values.reduce((total, value) => total + selector(value), 0);
}

function normalizeIdentifier(value, label, maxLength = 256) {
  if (typeof value !== "string") throw new TypeError(`Debrief ${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || containsUnsafeControl(normalized)) {
    throw new TypeError(`Debrief ${label} is invalid.`);
  }
  return normalized;
}

function normalizeOptionalIdentifier(value, label, maxLength) {
  if (value === undefined || value === null) return null;
  return normalizeIdentifier(value, label, maxLength);
}

function normalizeReason(value) {
  return normalizeIdentifier(value, "stop reason", 256);
}

function normalizeBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be a boolean.`);
  return value;
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
