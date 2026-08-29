import readline from "node:readline";

let active = false;
let sessionId = null;
let sessionCounter = 0;
let revision = 0;
let firstPacket = null;
let liveFinalEmitted = false;
let diarization = "off";
let model = "small";
let translation = "off";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    emit({
      type: "error",
      source: "protocol",
      code: "invalid_json",
      message: "Invalid JSON command.",
      recoverable: true
    });
    return;
  }

  if (command.type === "start") {
    active = true;
    sessionId = `fake-session-${++sessionCounter}`;
    revision = 0;
    firstPacket = null;
    liveFinalEmitted = false;
    diarization = command.diarization === "online" ? "online" : "off";
    model = typeof command.model === "string" ? command.model : "small";
    translation = command.translation === "en_to_pt_br" ? "en_to_pt_br" : "off";
    emit(engineStatus("loading"));
    emit(modelProgress("checking_cache"));
    if (process.env.MEETING_TRANSCRIBER_FAKE_MODEL_DOWNLOAD === "1") {
      emit(modelProgress("downloading"));
    }
    emit(modelProgress("verifying"));
    if (diarization === "online" && process.env.MEETING_TRANSCRIBER_FAKE_DIARIZATION_UNAVAILABLE === "1") {
      diarization = "off";
      emit({
        type: "warning",
        source: "transcription",
        code: "diarization_unavailable",
        message: "Speaker identification is unavailable. Transcription will continue without speaker labels.",
        recoverable: true
      });
    }
    const delayMs = Number.parseInt(process.env.MEETING_TRANSCRIBER_FAKE_START_DELAY_MS ?? "25", 10);
    setTimeout(() => {
      emit(modelProgress("initializing"));
      if (diarization === "online") emit(modelProgress("preparing_speakers"));
      if (translation === "en_to_pt_br") {
        emit(modelProgress("checking_translation_cache"));
        emit(modelProgress("downloading_translation"));
        emit(modelProgress("verifying_translation"));
        emit(modelProgress("converting_translation"));
        emit(modelProgress("initializing_translation"));
        if (process.env.MEETING_TRANSCRIBER_FAKE_TRANSLATION_UNAVAILABLE === "1") {
          translation = "off";
          emit({
            type: "warning",
            source: "transcription",
            code: "translation_unavailable",
            message: "Brazilian Portuguese translation is unavailable for this meeting. Original English will continue.",
            recoverable: true
          });
        }
      }
      emit(engineStatus("ready"));
    }, Number.isFinite(delayMs) ? delayMs : 25);
    return;
  }

  if (command.type === "audio" && active) {
    firstPacket ??= command;
    if (revision === 0) {
      revision = 1;
      emit({
        type: "partial_transcript",
        session_id: sessionId,
        segment: segment(false, command, "Local test transcript…")
      });
    }
    if (!liveFinalEmitted) {
      revision += 1;
      liveFinalEmitted = true;
      emit({
        type: "final_segment",
        session_id: sessionId,
        segment: segment(true, command, "Local test transcript.")
      });
    }
    return;
  }

  if (command.type === "stop" && active) {
    const delayMs = Number.parseInt(process.env.MEETING_TRANSCRIBER_FAKE_STOP_DELAY_MS ?? "0", 10);
    setTimeout(completeStop, Number.isFinite(delayMs) ? delayMs : 0);
    return;
  }

  if (command.type === "shutdown") {
    if (active) emit({ type: "session_stopped", session_id: sessionId, reason: "shutdown" });
    emit(engineStatus("shutdown"));
    process.exit(0);
  }
});

function engineStatus(status) {
  return {
    type: "engine_status",
    status,
    session_id: sessionId,
    model,
    language: "en",
    device: "cpu",
    compute: "int8"
  };
}

function modelProgress(phase) {
  return {
    type: "model_progress",
    phase,
    session_id: sessionId
  };
}

function segment(final, packet, text) {
  return {
    id: "fake-segment-1",
    revision,
    start_ms: packet.start_ms,
    end_ms: packet.end_ms,
    track: packet.track,
    text,
    partial: !final,
    final,
    language: "en",
    speaker_id: diarization === "online" && packet.track === "system" ? "speaker-01" : null,
    translated_text: final && translation === "en_to_pt_br" ? "Transcrição local de teste." : null,
    translated_language: final && translation === "en_to_pt_br" ? "pt-BR" : null
  };
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function completeStop() {
  if (!active) return;
  if (firstPacket) {
    revision += 1;
    emit({
      type: "final_segment",
      session_id: sessionId,
      segment: segment(true, firstPacket, "Local test transcript.")
    });
  }
  active = false;
  emit({ type: "session_stopped", session_id: sessionId, reason: "stopped" });
}
