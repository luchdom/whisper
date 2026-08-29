const TRACKS = new Set(["system", "microphone"]);
const ENGINE_STATUSES = new Set([
  "configured",
  "loading",
  "ready",
  "flushed",
  "shutdown",
  "unavailable"
]);
const MODEL_LOAD_PHASES = new Set([
  "checking_cache",
  "downloading",
  "verifying",
  "initializing",
  "preparing_speakers",
  "checking_translation_cache",
  "downloading_translation",
  "verifying_translation",
  "converting_translation",
  "initializing_translation"
]);
const EVENT_TYPES = new Set([
  "engine_status",
  "model_progress",
  "warning",
  "error",
  "partial_transcript",
  "final_segment",
  "session_stopped"
]);

export const MAX_AUDIO_PACKET_BYTES = 64_000;
export const MAX_BACKEND_LINE_BYTES = 2_000_000;

export class ProtocolValidationError extends Error {
  constructor(message, code = "invalid_protocol") {
    super(message);
    this.name = "ProtocolValidationError";
    this.code = code;
  }
}

export function parseBackendLine(line) {
  if (typeof line !== "string" || line.length === 0) {
    throw new ProtocolValidationError("Backend output must be a non-empty JSON line.");
  }

  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ProtocolValidationError("Backend emitted malformed JSON.", "malformed_backend_output");
  }

  return validateBackendEvent(value);
}

export function validateBackendEvent(value) {
  const event = requireRecord(value, "Backend event");
  const type = requireString(event.type, "event.type", 64);
  if (!EVENT_TYPES.has(type)) {
    throw new ProtocolValidationError(`Unsupported backend event type: ${type}`);
  }

  if (type === "engine_status") {
    const status = requireString(event.status, "engine_status.status", 64);
    if (!ENGINE_STATUSES.has(status)) {
      throw new ProtocolValidationError(`Unsupported engine status: ${status}`);
    }
    return compactObject({
      type,
      status,
      session_id: optionalString(event.session_id, "engine_status.session_id", 256),
      language: optionalString(event.language, "engine_status.language", 64),
      device: optionalString(event.device, "engine_status.device", 64),
      compute: optionalString(event.compute, "engine_status.compute", 64)
    });
  }

  if (type === "model_progress") {
    const phase = requireString(event.phase, "model_progress.phase", 64);
    if (!MODEL_LOAD_PHASES.has(phase)) {
      throw new ProtocolValidationError(`Unsupported model load phase: ${phase}`);
    }
    return compactObject({
      type,
      phase,
      session_id: optionalString(event.session_id, "model_progress.session_id", 256)
    });
  }

  if (type === "warning" || type === "error") {
    return compactObject({
      type,
      source: requireOneOf(event.source, ["protocol", "capture", "transcription"], "issue.source"),
      code: requireString(event.code, "issue.code", 128),
      message: requireString(event.message, "issue.message", 2_000),
      recoverable: requireBoolean(event.recoverable, "issue.recoverable"),
      segment_id: optionalString(event.segment_id, "issue.segment_id", 256)
    });
  }

  if (type === "partial_transcript" || type === "final_segment") {
    return {
      type,
      session_id: requireString(event.session_id, "transcript.session_id", 256),
      segment: validateSegment(event.segment, type)
    };
  }

  return compactObject({
    type,
    session_id: optionalString(event.session_id, "session_stopped.session_id", 256),
    reason: optionalString(event.reason, "session_stopped.reason", 256)
  });
}

export function createStartCommand(options = {}) {
  const input = requireRecord(options, "Start options");
  const command = { type: "start" };
  for (const key of [
    "model", "language", "device", "compute", "download_root", "diarization_model", "translation_model"
  ]) {
    if (!(key in input) || input[key] === undefined) continue;
    if ((key === "language" || key === "download_root" || key === "diarization_model" || key === "translation_model") && input[key] === null) {
      command[key] = null;
      continue;
    }
    command[key] = requireString(input[key], `start.${key}`, 1_024);
  }
  if (input.diarization !== undefined) {
    command.diarization = requireOneOf(input.diarization, ["off", "online"], "start.diarization");
  }
  if (input.translation !== undefined) {
    command.translation = requireOneOf(input.translation, ["off", "en_to_pt_br"], "start.translation");
  }
  return command;
}

export function createAudioCommand(packet) {
  const input = requireRecord(packet, "Audio packet");
  const track = requireOneOf(input.track, [...TRACKS], "audio.track");
  const startMs = requireInteger(input.startMs, "audio.startMs", 0);
  const endMs = requireInteger(input.endMs, "audio.endMs", 1);
  if (endMs <= startMs) {
    throw new ProtocolValidationError("audio.endMs must be greater than audio.startMs.");
  }

  const pcm = toUint8Array(input.pcm);
  if (pcm.byteLength === 0 || pcm.byteLength % 2 !== 0) {
    throw new ProtocolValidationError("Audio PCM must contain complete signed 16-bit samples.");
  }
  if (pcm.byteLength > MAX_AUDIO_PACKET_BYTES) {
    throw new ProtocolValidationError("Audio packet exceeds the desktop safety limit.");
  }
  const durationMs = Math.max(1, Math.round((pcm.byteLength / 2) * 1_000 / 16_000));
  if (endMs !== startMs + durationMs) {
    throw new ProtocolValidationError("Audio timestamps do not match the 16 kHz PCM sample count.");
  }

  return {
    type: "audio",
    track,
    start_ms: startMs,
    end_ms: endMs,
    pcm_s16le_base64: Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64")
  };
}

function validateSegment(value, eventType) {
  const segment = requireRecord(value, "Transcript segment");
  const partial = requireBoolean(segment.partial, "segment.partial");
  const final = requireBoolean(segment.final, "segment.final");
  if (partial === final) {
    throw new ProtocolValidationError("Segment partial and final flags must be complementary.");
  }
  if (eventType === "partial_transcript" && !partial) {
    throw new ProtocolValidationError("Partial event requires segment.partial=true.");
  }
  if (eventType === "final_segment" && !final) {
    throw new ProtocolValidationError("Final event requires segment.final=true.");
  }

  const startMs = requireInteger(segment.start_ms, "segment.start_ms", 0);
  const endMs = requireInteger(segment.end_ms, "segment.end_ms", 0);
  if (endMs < startMs) {
    throw new ProtocolValidationError("segment.end_ms must not be before segment.start_ms.");
  }

  const translatedText = optionalString(segment.translated_text, "segment.translated_text", 20_000);
  const translatedLanguage = optionalString(segment.translated_language, "segment.translated_language", 16);
  if (translatedText === undefined) {
    if (translatedLanguage !== undefined) {
      throw new ProtocolValidationError("segment.translated_language must be null when translated text is absent.");
    }
  } else {
    if (!final) throw new ProtocolValidationError("Partial segments cannot contain translated text.");
    if (translatedLanguage !== "pt-BR") {
      throw new ProtocolValidationError("Translated segments require segment.translated_language=pt-BR.");
    }
  }

  return compactObject({
    id: requireString(segment.id, "segment.id", 256),
    revision: requireInteger(segment.revision, "segment.revision", 0),
    start_ms: startMs,
    end_ms: endMs,
    track: requireOneOf(segment.track, [...TRACKS], "segment.track"),
    text: requireString(segment.text, "segment.text", 20_000, true),
    partial,
    final,
    language: optionalString(segment.language, "segment.language", 64),
    speaker_id: optionalString(segment.speaker_id, "segment.speaker_id", 256),
    translated_text: translatedText,
    translated_language: translatedLanguage
  });
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError(`${label} must be an object.`);
  }
  return value;
}

function requireString(value, label, maxLength, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0) || value.length > maxLength) {
    throw new ProtocolValidationError(`${label} must be a valid string.`);
  }
  return value;
}

function optionalString(value, label, maxLength) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, label, maxLength, true);
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") {
    throw new ProtocolValidationError(`${label} must be a boolean.`);
  }
  return value;
}

function requireInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new ProtocolValidationError(`${label} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function requireOneOf(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new ProtocolValidationError(`${label} has an unsupported value.`);
  }
  return value;
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new ProtocolValidationError("audio.pcm must be an ArrayBuffer or typed array.");
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
