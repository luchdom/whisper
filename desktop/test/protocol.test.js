import assert from "node:assert/strict";
import test from "node:test";
import {
  ProtocolValidationError,
  createAudioCommand,
  createStartCommand,
  parseBackendLine,
  validateBackendEvent
} from "../main/protocol.js";

test("start commands preserve validated model, diarization, translation, and main-owned roots", () => {
  assert.deepEqual(createStartCommand({
    model: "small.en",
    language: "en",
    device: "cpu",
    compute: "int8",
    download_root: "C:\\safe-app-data\\models\\asr",
    diarization: "online",
    diarization_model: "C:\\safe-app-data\\models\\speaker.onnx",
    translation: "en_to_pt_br",
    translation_model: "C:\\safe-app-data\\models\\translation"
  }), {
    type: "start",
    model: "small.en",
    language: "en",
    device: "cpu",
    compute: "int8",
    download_root: "C:\\safe-app-data\\models\\asr",
    diarization_model: "C:\\safe-app-data\\models\\speaker.onnx",
    translation_model: "C:\\safe-app-data\\models\\translation",
    diarization: "online",
    translation: "en_to_pt_br"
  });
  assert.throws(() => createStartCommand({ diarization: "custom" }), /start\.diarization/);
  assert.throws(() => createStartCommand({ diarization_model: 42 }), /diarization_model/);
  assert.throws(() => createStartCommand({ translation: "cloud" }), /start\.translation/);
  assert.throws(() => createStartCommand({ translation_model: 42 }), /translation_model/);
});

test("backend transcript events are strictly validated and sanitized", () => {
  const event = parseBackendLine(JSON.stringify({
    type: "final_segment",
    session_id: "session-1",
    ignored: "not relayed",
    segment: {
      id: "segment-1",
      revision: 2,
      start_ms: 0,
      end_ms: 200,
      track: "system",
      text: "Olá",
      partial: false,
      final: true,
      language: "pt",
      speaker_id: null,
      translated_text: "Hello in Portuguese",
      translated_language: "pt-BR",
      ignored: "not relayed"
    }
  }));
  assert.equal(event.type, "final_segment");
  assert.equal(event.session_id, "session-1");
  assert.equal(event.segment.text, "Olá");
  assert.equal(event.segment.translated_text, "Hello in Portuguese");
  assert.equal(event.segment.translated_language, "pt-BR");
  assert.equal("ignored" in event, false);
  assert.equal("ignored" in event.segment, false);
});

test("every model and translation progress phase is accepted and raw backend details are stripped", () => {
  const phases = [
    "checking_cache", "downloading", "verifying", "initializing", "preparing_speakers",
    "checking_translation_cache", "downloading_translation", "verifying_translation",
    "converting_translation", "initializing_translation"
  ];
  for (const phase of phases) {
    const event = validateBackendEvent({
      type: "model_progress",
      phase,
      session_id: "session-1",
      model: "C:\\private\\models\\small.en",
      local_path: "C:\\private\\cache",
      percent: 73,
      provider_exception: "secret"
    });
    assert.deepEqual(event, { type: "model_progress", phase, session_id: "session-1" });
  }
  assert.throws(() => validateBackendEvent({
    type: "model_progress",
    phase: "almost_done"
  }), /model load phase/);

  const status = validateBackendEvent({
    type: "engine_status",
    status: "loading",
    session_id: "session-1",
    model: "C:\\private\\models\\small.en",
    language: "en",
    device: "cpu",
    compute: "int8"
  });
  assert.equal("model" in status, false);
});

test("translated segment fields are nullable, atomic, bounded, final-only, and fixed to pt-BR", () => {
  const base = {
    type: "final_segment",
    session_id: "session-1",
    segment: {
      id: "segment-1",
      revision: 1,
      start_ms: 0,
      end_ms: 1,
      track: "system",
      text: "Original",
      partial: false,
      final: true,
      language: "en"
    }
  };
  assert.equal(validateBackendEvent(base).segment.translated_text, undefined);
  assert.equal(validateBackendEvent({
    ...base,
    segment: { ...base.segment, translated_text: null, translated_language: null }
  }).segment.translated_text, undefined);
  assert.throws(() => validateBackendEvent({
    ...base,
    segment: { ...base.segment, translated_language: "pt-BR" }
  }), /must be null/);
  assert.throws(() => validateBackendEvent({
    ...base,
    segment: { ...base.segment, translated_text: "Tradução", translated_language: "pt" }
  }), /pt-BR/);
  assert.throws(() => validateBackendEvent({
    ...base,
    segment: { ...base.segment, translated_text: "x".repeat(20_001), translated_language: "pt-BR" }
  }), /valid string/);
  assert.throws(() => validateBackendEvent({
    ...base,
    type: "partial_transcript",
    segment: {
      ...base.segment,
      partial: true,
      final: false,
      translated_text: "Tradução",
      translated_language: "pt-BR"
    }
  }), /Partial segments/);
});

test("malformed, contradictory, and unsupported backend events fail closed", () => {
  assert.throws(() => parseBackendLine("not-json"), ProtocolValidationError);
  assert.throws(() => validateBackendEvent({ type: "unknown" }), ProtocolValidationError);
  assert.throws(() => validateBackendEvent({
    type: "partial_transcript",
    session_id: "session-1",
    segment: {
      id: "x",
      revision: 0,
      start_ms: 0,
      end_ms: 1,
      track: "system",
      text: "x",
      partial: false,
      final: true
    }
  }), ProtocolValidationError);
  assert.throws(() => validateBackendEvent({
    type: "final_segment",
    segment: {
      id: "x",
      revision: 1,
      start_ms: 0,
      end_ms: 1,
      track: "system",
      text: "x",
      partial: false,
      final: true
    }
  }), /session_id/);
});

test("audio commands enforce track, size, and exact 16 kHz packet timing", () => {
  const pcm = new Uint8Array(6_400);
  const command = createAudioCommand({ track: "microphone", startMs: 400, endMs: 600, pcm });
  assert.equal(command.type, "audio");
  assert.equal(command.track, "microphone");
  assert.equal(command.start_ms, 400);
  assert.equal(command.end_ms, 600);
  assert.equal(Buffer.from(command.pcm_s16le_base64, "base64").byteLength, pcm.byteLength);

  assert.throws(() => createAudioCommand({ track: "mixed", startMs: 0, endMs: 200, pcm }));
  assert.throws(() => createAudioCommand({ track: "system", startMs: 0, endMs: 201, pcm }));
  assert.throws(() => createAudioCommand({ track: "system", startMs: 0, endMs: 1, pcm: new Uint8Array(3) }));
});
