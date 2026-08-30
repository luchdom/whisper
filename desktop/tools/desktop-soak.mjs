import { spawn, execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DESKTOP_SOAK_SCHEMA_VERSION = 1;
export const MIN_RELEASE_DURATION_SECONDS = 3_600;
export const RESULT_PREFIX = "__MEETING_TRANSCRIBER_DESKTOP_SOAK_V1__";
const FAILURE_PREFIX = "__MEETING_TRANSCRIBER_DESKTOP_SOAK_FAILURE_V1__";

const TEST_NAME = "native_electron_desktop_soak";
const EVIDENCE_KIND = "native_desktop_observation";
const PACKET_DURATION_MS = 200;
const MEMORY_SAMPLE_INTERVAL_MS = 5_000;
const MIN_RELEASE_MEMORY_SAMPLES = 600;
const MIN_STABLE_WINDOW_SAMPLES = 60;
const MAX_MEMORY_GROWTH_MIB = 512;
const MAX_ASSIST_P95_MS = 30_000;
const MAX_ASSIST_MS = 60_000;
const TEMP_PREFIX = "meeting-transcriber-desktop-soak-";
const MAX_CHILD_STDOUT_BYTES = 128 * 1024;
const CANARY_SCAN_CHUNK_BYTES = 64 * 1024;
export const DESKTOP_SOAK_CONTEXT_CANARY = "MEETING-TRANSCRIBER-SOAK-CONTEXT-CANARY-V1";
const AUDIO_EXTENSIONS = new Set([
  ".aac", ".aiff", ".caf", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".pcm", ".raw",
  ".wav", ".webm", ".wma"
]);
const TRANSCRIPT_EXTENSIONS = new Set([".csv", ".md", ".srt", ".tsv", ".txt", ".vtt"]);
const EXPECTED_USER_DATA_FILES = new Set([
  "Local State",
  "Network Persistent State",
  "OriginTrials",
  "Preferences",
  "TransportSecurity",
  "Trust Tokens",
  "Trust Tokens-journal",
  "Variations",
  "overlay-settings.json",
  "settings.json"
]);
const EXPECTED_USER_DATA_DIRECTORIES = new Set([
  "blob_storage",
  "Cache",
  "Code Cache",
  "Crashpad",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "Dictionaries",
  "GPUCache",
  "GrShaderCache",
  "Local Storage",
  "Network",
  "Session Storage",
  "Shared Dictionary",
  "Storage",
  "WebStorage",
  "models",
  "shared_proto_db"
]);
const FORBIDDEN_SOAK_CHANNELS = new Set([
  "meeting:context-pack-create",
  "meeting:context-pack-update",
  "meeting:context-pack-delete",
  "meeting:copy",
  "meeting:debrief-copy",
  "meeting:debrief-clear",
  "meeting:debrief-generate",
  "meeting:debrief-save",
  "meeting:provider-import-clipboard",
  "meeting:provider-open-link",
  "meeting:provider-revoke",
  "meeting:save",
  "meeting:settings-choose-directory",
  "meeting:settings-clear-directory",
  "meeting:settings-update"
]);
const CRITICAL_BACKEND_CODES = new Set([
  "audio_gap",
  "engine_initialization_failed",
  "inference_backpressure",
  "inference_failed",
  "non_monotonic_audio",
  "translation_unavailable"
]);
const SENSITIVE_ENVIRONMENT_KEY = /(api.?key|authorization|bearer|credential|oauth|password|secret|session|token)/iu;

const TOP_LEVEL_KEYS = Object.freeze([
  "schema_version",
  "test",
  "evidence_kind",
  "acceptance_scope",
  "platform",
  "runtime",
  "sidecar",
  "synthetic_input_confirmed",
  "synthetic_context_confirmed",
  "duration_seconds",
  "capture",
  "renderer",
  "assist",
  "process_tree_memory",
  "lifecycle",
  "autosave",
  "privacy",
  "checkpoints"
]);

const SECTION_KEYS = Object.freeze({
  capture: [
    "packet_count",
    "system_packet_count",
    "microphone_packet_count",
    "source_count",
    "covered_duration_ms",
    "gap_count",
    "max_gap_ms",
    "rejected_packet_count"
  ],
  renderer: [
    "backend_event_count",
    "final_event_count",
    "rendered_final_count",
    "reconciliation_mismatch_count"
  ],
  assist: [
    "request_count",
    "completed_count",
    "failed_count",
    "canceled_count",
    "rendered_result_count",
    "latency_ms"
  ],
  latency_ms: ["count", "p50", "p95", "max"],
  process_tree_memory: [
    "available",
    "sample_count",
    "stable_first_count",
    "stable_last_count",
    "working_set_peak_mib",
    "working_set_growth_mib",
    "private_available",
    "private_peak_mib",
    "private_growth_mib"
  ],
  lifecycle: [
    "start_success_count",
    "stop_request_count",
    "capture_drained",
    "backend_stopped",
    "renderer_finalized",
    "app_exit_clean"
  ],
  autosave: ["request_count", "created", "existed_after_stop", "cleanup_succeeded"],
  privacy: [
    "critical_event_count",
    "privacy_event_count",
    "inspection_completed",
    "artifact_file_count",
    "artifact_directory_count",
    "artifact_special_count",
    "expected_artifact_count",
    "unexpected_artifact_count",
    "audio_artifact_count",
    "transcript_artifact_count",
    "context_artifact_count",
    "plaintext_artifact_count",
    "canary_match_count",
    "unexpected_stdout_line_count",
    "audio_retained",
    "transcript_retained",
    "context_retained",
    "file_paths_emitted"
  ],
  checkpoints: [
    "native_capture_started",
    "capture_to_ipc",
    "ipc_to_sidecar",
    "sidecar_to_renderer",
    "renderer_reconciled",
    "renderer_to_autosave",
    "renderer_to_assist",
    "assist_canary_injected",
    "assist_canary_rendered"
  ]
});

export class DesktopSoakContractError extends Error {
  constructor(code) {
    super("Desktop soak evidence did not match the aggregate contract.");
    this.name = "DesktopSoakContractError";
    this.code = code;
  }
}

export function evaluateDesktopSoak(value) {
  const evidence = validateEvidence(value);
  const acceptanceFailures = [];

  addFailure(acceptanceFailures, evidence.acceptance_scope !== "release", "release_scope_required");
  addFailure(
    acceptanceFailures,
    evidence.duration_seconds < MIN_RELEASE_DURATION_SECONDS,
    "minimum_duration_not_met"
  );
  addFailure(acceptanceFailures, evidence.sidecar !== "real", "real_sidecar_required");
  addFailure(
    acceptanceFailures,
    evidence.synthetic_input_confirmed !== true,
    "synthetic_input_confirmation_required"
  );
  addFailure(
    acceptanceFailures,
    evidence.synthetic_context_confirmed !== true,
    "synthetic_context_confirmation_required"
  );

  const expectedCaptureDurationMs = Math.round(evidence.duration_seconds * 1_000);
  addFailure(acceptanceFailures, evidence.capture.packet_count === 0, "capture_packets_missing");
  addFailure(
    acceptanceFailures,
    evidence.capture.packet_count !== (
      evidence.capture.system_packet_count + evidence.capture.microphone_packet_count
    ),
    "capture_packet_count_mismatch"
  );
  const observedSourceCount = Number(evidence.capture.system_packet_count > 0)
    + Number(evidence.capture.microphone_packet_count > 0);
  addFailure(
    acceptanceFailures,
    evidence.capture.source_count !== observedSourceCount,
    "capture_source_count_mismatch"
  );
  addFailure(
    acceptanceFailures,
    evidence.capture.system_packet_count === 0,
    "system_capture_missing"
  );
  addFailure(acceptanceFailures, evidence.capture.source_count === 0, "capture_source_missing");
  addFailure(
    acceptanceFailures,
    Math.abs(evidence.capture.covered_duration_ms - expectedCaptureDurationMs)
      > (PACKET_DURATION_MS * 10),
    "capture_duration_mismatch"
  );
  addFailure(acceptanceFailures, evidence.capture.gap_count !== 0, "capture_gap_detected");
  addFailure(
    acceptanceFailures,
    evidence.capture.rejected_packet_count !== 0,
    "capture_packet_rejected"
  );

  addFailure(
    acceptanceFailures,
    evidence.renderer.backend_event_count === 0,
    "renderer_backend_events_missing"
  );
  addFailure(
    acceptanceFailures,
    evidence.renderer.final_event_count === 0,
    "renderer_final_events_missing"
  );
  addFailure(
    acceptanceFailures,
    evidence.renderer.rendered_final_count === 0,
    "renderer_finals_missing"
  );
  addFailure(
    acceptanceFailures,
    evidence.renderer.reconciliation_mismatch_count !== 0,
    "renderer_reconciliation_mismatch"
  );
  const observedRendererMismatch = Math.abs(
    evidence.renderer.final_event_count - evidence.renderer.rendered_final_count
  );
  addFailure(
    acceptanceFailures,
    observedRendererMismatch !== 0,
    "renderer_final_count_mismatch"
  );
  addFailure(
    acceptanceFailures,
    evidence.renderer.reconciliation_mismatch_count !== observedRendererMismatch,
    "renderer_reconciliation_metric_invalid"
  );

  addFailure(
    acceptanceFailures,
    evidence.assist.request_count !== 1,
    "single_assist_request_required"
  );
  addFailure(
    acceptanceFailures,
    evidence.assist.completed_count !== evidence.assist.request_count,
    "assist_request_incomplete"
  );
  addFailure(acceptanceFailures, evidence.assist.failed_count !== 0, "assist_request_failed");
  addFailure(acceptanceFailures, evidence.assist.canceled_count !== 0, "assist_request_canceled");
  addFailure(
    acceptanceFailures,
    evidence.assist.rendered_result_count !== evidence.assist.completed_count,
    "assist_result_not_rendered"
  );
  addFailure(
    acceptanceFailures,
    evidence.assist.latency_ms.count !== evidence.assist.completed_count,
    "assist_latency_incomplete"
  );
  addFailure(
    acceptanceFailures,
    evidence.assist.latency_ms.p95 === null || evidence.assist.latency_ms.p95 > MAX_ASSIST_P95_MS,
    "assist_p95_latency_exceeded"
  );
  addFailure(
    acceptanceFailures,
    evidence.assist.latency_ms.max === null || evidence.assist.latency_ms.max > MAX_ASSIST_MS,
    "assist_max_latency_exceeded"
  );

  const memory = evidence.process_tree_memory;
  addFailure(acceptanceFailures, !memory.available, "process_tree_memory_unavailable");
  addFailure(
    acceptanceFailures,
    memory.sample_count < MIN_RELEASE_MEMORY_SAMPLES,
    "process_tree_memory_samples_incomplete"
  );
  addFailure(
    acceptanceFailures,
    memory.stable_first_count < MIN_STABLE_WINDOW_SAMPLES,
    "process_tree_first_window_incomplete"
  );
  addFailure(
    acceptanceFailures,
    memory.stable_last_count < MIN_STABLE_WINDOW_SAMPLES,
    "process_tree_last_window_incomplete"
  );
  addFailure(
    acceptanceFailures,
    memory.working_set_growth_mib === null
      || memory.working_set_growth_mib > MAX_MEMORY_GROWTH_MIB,
    "process_tree_memory_growth_exceeded"
  );
  addFailure(
    acceptanceFailures,
    memory.private_available
      && (memory.private_growth_mib === null
        || memory.private_growth_mib > MAX_MEMORY_GROWTH_MIB),
    "process_tree_private_memory_growth_exceeded"
  );

  addFailure(
    acceptanceFailures,
    evidence.lifecycle.start_success_count !== 1,
    "single_start_required"
  );
  addFailure(
    acceptanceFailures,
    evidence.lifecycle.stop_request_count !== 1,
    "single_stop_required"
  );
  addFailure(acceptanceFailures, !evidence.lifecycle.capture_drained, "capture_not_drained");
  addFailure(acceptanceFailures, !evidence.lifecycle.backend_stopped, "backend_not_stopped");
  addFailure(acceptanceFailures, !evidence.lifecycle.renderer_finalized, "renderer_not_finalized");
  addFailure(acceptanceFailures, !evidence.lifecycle.app_exit_clean, "app_exit_not_clean");

  addFailure(
    acceptanceFailures,
    evidence.autosave.request_count !== 1,
    "single_autosave_required"
  );
  addFailure(acceptanceFailures, !evidence.autosave.created, "autosave_not_created");
  addFailure(
    acceptanceFailures,
    !evidence.autosave.existed_after_stop,
    "autosave_not_observed_after_stop"
  );
  addFailure(
    acceptanceFailures,
    !evidence.autosave.cleanup_succeeded,
    "temporary_state_cleanup_failed"
  );

  addFailure(
    acceptanceFailures,
    evidence.privacy.critical_event_count !== 0,
    "critical_event_detected"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.privacy_event_count !== 0,
    "privacy_event_detected"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.inspection_completed !== true,
    "privacy_inspection_missing"
  );
  const artifactCount = evidence.privacy.artifact_file_count
    + evidence.privacy.artifact_directory_count
    + evidence.privacy.artifact_special_count;
  addFailure(
    acceptanceFailures,
    artifactCount !== (
      evidence.privacy.expected_artifact_count + evidence.privacy.unexpected_artifact_count
    ),
    "privacy_artifact_inventory_mismatch"
  );
  addFailure(
    acceptanceFailures,
    [
      evidence.privacy.audio_artifact_count,
      evidence.privacy.transcript_artifact_count,
      evidence.privacy.context_artifact_count,
      evidence.privacy.plaintext_artifact_count,
      evidence.privacy.canary_match_count
    ].some((count) => count > evidence.privacy.artifact_file_count),
    "privacy_artifact_metric_invalid"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.artifact_special_count !== 0,
    "special_artifact_detected"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.unexpected_artifact_count !== 0,
    "unexpected_artifact_detected"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.audio_artifact_count !== 0,
    "audio_artifact_detected"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.transcript_artifact_count !== 1,
    "autosave_artifact_count_invalid"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.context_artifact_count !== 0,
    "context_artifact_detected"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.plaintext_artifact_count !== 0,
    "unexpected_plaintext_artifact_detected"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.canary_match_count !== 0,
    "privacy_canary_persisted"
  );
  addFailure(
    acceptanceFailures,
    evidence.privacy.unexpected_stdout_line_count !== 0,
    "unexpected_stdout_detected"
  );
  addFailure(acceptanceFailures, evidence.privacy.audio_retained, "audio_retained");
  addFailure(acceptanceFailures, evidence.privacy.transcript_retained, "transcript_retained");
  addFailure(acceptanceFailures, evidence.privacy.context_retained, "context_retained");
  addFailure(acceptanceFailures, evidence.privacy.file_paths_emitted, "file_path_emitted");

  for (const checkpoint of SECTION_KEYS.checkpoints) {
    addFailure(
      acceptanceFailures,
      evidence.checkpoints[checkpoint] !== true,
      `checkpoint_${checkpoint}_missing`
    );
  }

  const contractPassed = evidence.privacy.critical_event_count === 0
    && evidence.privacy.privacy_event_count === 0
    && evidence.privacy.inspection_completed === true
    && artifactCount === (
      evidence.privacy.expected_artifact_count + evidence.privacy.unexpected_artifact_count
    )
    && evidence.privacy.artifact_special_count === 0
    && evidence.privacy.unexpected_artifact_count === 0
    && evidence.privacy.audio_artifact_count === 0
    && evidence.privacy.transcript_artifact_count === 1
    && evidence.privacy.context_artifact_count === 0
    && evidence.privacy.plaintext_artifact_count === 0
    && evidence.privacy.canary_match_count === 0
    && evidence.privacy.unexpected_stdout_line_count === 0
    && evidence.privacy.audio_retained === false
    && evidence.privacy.transcript_retained === false
    && evidence.privacy.context_retained === false
    && evidence.privacy.file_paths_emitted === false;

  return Object.freeze({
    schema_version: DESKTOP_SOAK_SCHEMA_VERSION,
    test: TEST_NAME,
    evidence_kind: evidence.evidence_kind,
    acceptance_scope: evidence.acceptance_scope,
    contract_passed: contractPassed,
    passed: contractPassed && acceptanceFailures.length === 0,
    platform: evidence.platform,
    runtime: evidence.runtime,
    sidecar: evidence.sidecar,
    synthetic_input_confirmed: evidence.synthetic_input_confirmed,
    synthetic_context_confirmed: evidence.synthetic_context_confirmed,
    duration_seconds: evidence.duration_seconds,
    capture: evidence.capture,
    renderer: evidence.renderer,
    assist: evidence.assist,
    process_tree_memory: evidence.process_tree_memory,
    stop_and_drain: evidence.lifecycle,
    autosave: evidence.autosave,
    critical_event_count: evidence.privacy.critical_event_count,
    privacy_event_count: evidence.privacy.privacy_event_count,
    retention: Object.freeze({
      audio: evidence.privacy.audio_retained,
      transcript: evidence.privacy.transcript_retained,
      context: evidence.privacy.context_retained,
      file_paths: evidence.privacy.file_paths_emitted
    }),
    checkpoints: evidence.checkpoints,
    acceptance_failures: Object.freeze(acceptanceFailures)
  });
}

export function closedFailureResult(
  code = "native_observation_missing",
  scope = "release",
  {
    cleanupSucceeded = false,
    syntheticInputConfirmed = false,
    syntheticContextConfirmed = false
  } = {}
) {
  const safeCode = /^[a-z][a-z0-9_]{0,63}$/u.test(code) ? code : "desktop_soak_failed";
  const safeScope = ["release", "smoke"].includes(scope) ? scope : "release";
  return Object.freeze({
    schema_version: DESKTOP_SOAK_SCHEMA_VERSION,
    test: TEST_NAME,
    evidence_kind: EVIDENCE_KIND,
    acceptance_scope: safeScope,
    contract_passed: false,
    passed: false,
    platform: ["win32", "darwin"].includes(process.platform) ? process.platform : "unsupported",
    runtime: "source",
    sidecar: "unknown",
    synthetic_input_confirmed: syntheticInputConfirmed === true,
    synthetic_context_confirmed: syntheticContextConfirmed === true,
    duration_seconds: 0,
    capture: zeroCapture(),
    renderer: zeroRenderer(),
    assist: zeroAssist(),
    process_tree_memory: emptyMemorySummary(),
    stop_and_drain: zeroLifecycle(),
    autosave: Object.freeze({ ...zeroAutosave(), cleanup_succeeded: cleanupSucceeded }),
    critical_event_count: 1,
    privacy_event_count: 0,
    retention: Object.freeze({
      audio: true,
      transcript: true,
      context: true,
      file_paths: true
    }),
    checkpoints: zeroCheckpoints(),
    acceptance_failures: Object.freeze([safeCode])
  });
}

export function summarizeMemorySamples(samples, durationSeconds) {
  if (!Array.isArray(samples) || !Number.isFinite(durationSeconds) || durationSeconds < 0) {
    throw new DesktopSoakContractError("invalid_memory_samples");
  }
  const valid = samples.filter((sample) => isMemorySample(sample));
  if (valid.length === 0) return emptyMemorySummary();

  const stableFirst = valid.filter(({ elapsed_seconds: elapsed }) => elapsed >= 60 && elapsed <= 600);
  const stableLastStart = Math.max(0, durationSeconds - 600);
  const stableLastEnd = Math.max(stableLastStart, durationSeconds - 60);
  const stableLast = valid.filter(({ elapsed_seconds: elapsed }) => (
    elapsed >= stableLastStart && elapsed <= stableLastEnd
  ));
  const workingValues = valid.map(({ working_set_mib: value }) => value);
  const privateValues = valid
    .map(({ private_mib: value }) => value)
    .filter((value) => value !== null);
  const workingGrowth = growthBetweenWindows(stableFirst, stableLast, "working_set_mib");
  const privateGrowth = privateValues.length === valid.length
    ? growthBetweenWindows(stableFirst, stableLast, "private_mib")
    : null;

  return Object.freeze({
    available: true,
    sample_count: valid.length,
    stable_first_count: stableFirst.length,
    stable_last_count: stableLast.length,
    working_set_peak_mib: rounded(Math.max(...workingValues)),
    working_set_growth_mib: nullableRounded(workingGrowth),
    private_available: privateValues.length === valid.length,
    private_peak_mib: privateValues.length === valid.length
      ? rounded(Math.max(...privateValues))
      : null,
    private_growth_mib: nullableRounded(privateGrowth)
  });
}

export function summarizeLatencies(values) {
  if (!Array.isArray(values) || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new DesktopSoakContractError("invalid_assist_latency");
  }
  if (values.length === 0) {
    return Object.freeze({ count: 0, p50: null, p95: null, max: null });
  }
  const ordered = [...values].sort((left, right) => left - right);
  return Object.freeze({
    count: ordered.length,
    p50: rounded(percentile(ordered, 0.50)),
    p95: rounded(percentile(ordered, 0.95)),
    max: rounded(ordered.at(-1))
  });
}

function validateEvidence(value) {
  assertRecord(value, "invalid_evidence");
  assertExactKeys(value, TOP_LEVEL_KEYS, "invalid_evidence_shape");
  if (value.schema_version !== DESKTOP_SOAK_SCHEMA_VERSION
    || value.test !== TEST_NAME
    || value.evidence_kind !== EVIDENCE_KIND) {
    throw new DesktopSoakContractError("invalid_evidence_identity");
  }
  assertEnum(value.acceptance_scope, ["smoke", "release"], "invalid_acceptance_scope");
  assertEnum(value.platform, ["win32", "darwin"], "invalid_platform");
  assertEnum(value.runtime, ["source", "bundled"], "invalid_runtime");
  assertEnum(value.sidecar, ["real", "fake"], "invalid_sidecar");
  assertBoolean(value.synthetic_input_confirmed, "invalid_synthetic_input_confirmation");
  assertBoolean(value.synthetic_context_confirmed, "invalid_synthetic_context_confirmation");
  assertNumber(value.duration_seconds, "invalid_duration_seconds");

  validateNumberSection(value.capture, "capture", SECTION_KEYS.capture);
  validateNumberSection(value.renderer, "renderer", SECTION_KEYS.renderer);
  validateAssist(value.assist);
  validateMemory(value.process_tree_memory);
  validateMixedSection(value.lifecycle, "lifecycle", SECTION_KEYS.lifecycle, {
    start_success_count: "number",
    stop_request_count: "number",
    capture_drained: "boolean",
    backend_stopped: "boolean",
    renderer_finalized: "boolean",
    app_exit_clean: "boolean"
  });
  validateMixedSection(value.autosave, "autosave", SECTION_KEYS.autosave, {
    request_count: "number",
    created: "boolean",
    existed_after_stop: "boolean",
    cleanup_succeeded: "boolean"
  });
  validateMixedSection(value.privacy, "privacy", SECTION_KEYS.privacy, {
    critical_event_count: "number",
    privacy_event_count: "number",
    inspection_completed: "boolean",
    artifact_file_count: "number",
    artifact_directory_count: "number",
    artifact_special_count: "number",
    expected_artifact_count: "number",
    unexpected_artifact_count: "number",
    audio_artifact_count: "number",
    transcript_artifact_count: "number",
    context_artifact_count: "number",
    plaintext_artifact_count: "number",
    canary_match_count: "number",
    unexpected_stdout_line_count: "number",
    audio_retained: "boolean",
    transcript_retained: "boolean",
    context_retained: "boolean",
    file_paths_emitted: "boolean"
  });
  validateBooleanSection(value.checkpoints, "checkpoints", SECTION_KEYS.checkpoints);
  return deepFreezeClone(value);
}

function validateAssist(value) {
  assertRecord(value, "invalid_assist");
  assertExactKeys(value, SECTION_KEYS.assist, "invalid_assist_shape");
  for (const key of SECTION_KEYS.assist.filter((key) => key !== "latency_ms")) {
    assertInteger(value[key], `invalid_assist_${key}`);
  }
  assertRecord(value.latency_ms, "invalid_assist_latency");
  assertExactKeys(value.latency_ms, SECTION_KEYS.latency_ms, "invalid_assist_latency_shape");
  assertInteger(value.latency_ms.count, "invalid_assist_latency_count");
  for (const key of ["p50", "p95", "max"]) {
    if (value.latency_ms[key] !== null) assertNumber(value.latency_ms[key], `invalid_assist_latency_${key}`);
  }
}

function validateMemory(value) {
  assertRecord(value, "invalid_process_tree_memory");
  assertExactKeys(value, SECTION_KEYS.process_tree_memory, "invalid_process_tree_memory_shape");
  for (const key of ["available", "private_available"]) {
    assertBoolean(value[key], `invalid_process_tree_memory_${key}`);
  }
  for (const key of ["sample_count", "stable_first_count", "stable_last_count"]) {
    assertInteger(value[key], `invalid_process_tree_memory_${key}`);
  }
  for (const key of ["working_set_peak_mib", "private_peak_mib"]) {
    if (value[key] !== null) assertNumber(value[key], `invalid_process_tree_memory_${key}`);
  }
  for (const key of ["working_set_growth_mib", "private_growth_mib"]) {
    if (value[key] !== null) assertFinite(value[key], `invalid_process_tree_memory_${key}`);
  }
}

function validateNumberSection(value, name, keys) {
  assertRecord(value, `invalid_${name}`);
  assertExactKeys(value, keys, `invalid_${name}_shape`);
  for (const key of keys) assertInteger(value[key], `invalid_${name}_${key}`);
}

function validateBooleanSection(value, name, keys) {
  assertRecord(value, `invalid_${name}`);
  assertExactKeys(value, keys, `invalid_${name}_shape`);
  for (const key of keys) assertBoolean(value[key], `invalid_${name}_${key}`);
}

function validateMixedSection(value, name, keys, types) {
  assertRecord(value, `invalid_${name}`);
  assertExactKeys(value, keys, `invalid_${name}_shape`);
  for (const key of keys) {
    if (types[key] === "number") assertInteger(value[key], `invalid_${name}_${key}`);
    else assertBoolean(value[key], `invalid_${name}_${key}`);
  }
}

function assertRecord(value, code) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DesktopSoakContractError(code);
  }
}

function assertExactKeys(value, keys, code) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new DesktopSoakContractError(code);
  }
}

function assertEnum(value, allowed, code) {
  if (!allowed.includes(value)) throw new DesktopSoakContractError(code);
}

function assertBoolean(value, code) {
  if (typeof value !== "boolean") throw new DesktopSoakContractError(code);
}

function assertNumber(value, code) {
  if (!Number.isFinite(value) || value < 0) throw new DesktopSoakContractError(code);
}

function assertFinite(value, code) {
  if (!Number.isFinite(value)) throw new DesktopSoakContractError(code);
}

function assertInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new DesktopSoakContractError(code);
}

function deepFreezeClone(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreezeClone));
  if (!value || typeof value !== "object") return value;
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, deepFreezeClone(item)])
  ));
}

function addFailure(target, condition, code) {
  if (condition && !target.includes(code)) target.push(code);
}

function percentile(ordered, fraction) {
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function median(values) {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1] + ordered[middle]) / 2
    : ordered[middle];
}

function growthBetweenWindows(first, last, key) {
  const firstMedian = median(first.map((sample) => sample[key]).filter((value) => value !== null));
  const lastMedian = median(last.map((sample) => sample[key]).filter((value) => value !== null));
  return firstMedian === null || lastMedian === null ? null : lastMedian - firstMedian;
}

function rounded(value) {
  return Math.round(value * 10) / 10;
}

function nullableRounded(value) {
  return value === null ? null : rounded(value);
}

function isMemorySample(value) {
  return Boolean(value
    && typeof value === "object"
    && Number.isFinite(value.elapsed_seconds)
    && value.elapsed_seconds >= 0
    && Number.isFinite(value.working_set_mib)
    && value.working_set_mib >= 0
    && (value.private_mib === null
      || (Number.isFinite(value.private_mib) && value.private_mib >= 0)));
}

function zeroCapture() {
  return Object.freeze({
    packet_count: 0,
    system_packet_count: 0,
    microphone_packet_count: 0,
    source_count: 0,
    covered_duration_ms: 0,
    gap_count: 0,
    max_gap_ms: 0,
    rejected_packet_count: 0
  });
}

function zeroRenderer() {
  return Object.freeze({
    backend_event_count: 0,
    final_event_count: 0,
    rendered_final_count: 0,
    reconciliation_mismatch_count: 0
  });
}

function zeroAssist() {
  return Object.freeze({
    request_count: 0,
    completed_count: 0,
    failed_count: 0,
    canceled_count: 0,
    rendered_result_count: 0,
    latency_ms: Object.freeze({ count: 0, p50: null, p95: null, max: null })
  });
}

function emptyMemorySummary() {
  return Object.freeze({
    available: false,
    sample_count: 0,
    stable_first_count: 0,
    stable_last_count: 0,
    working_set_peak_mib: null,
    working_set_growth_mib: null,
    private_available: false,
    private_peak_mib: null,
    private_growth_mib: null
  });
}

function zeroLifecycle() {
  return Object.freeze({
    start_success_count: 0,
    stop_request_count: 0,
    capture_drained: false,
    backend_stopped: false,
    renderer_finalized: false,
    app_exit_clean: false
  });
}

function zeroAutosave() {
  return Object.freeze({
    request_count: 0,
    created: false,
    existed_after_stop: false,
    cleanup_succeeded: false
  });
}

function zeroCheckpoints() {
  return Object.freeze(Object.fromEntries(SECTION_KEYS.checkpoints.map((key) => [key, false])));
}

class RuntimeObservation {
  constructor({
    scope,
    sidecar,
    transcriptDirectory,
    syntheticInputConfirmed,
    syntheticContextConfirmed
  }) {
    this.scope = scope;
    this.sidecar = sidecar;
    this.transcriptDirectory = transcriptDirectory;
    this.syntheticInputConfirmed = syntheticInputConfirmed;
    this.syntheticContextConfirmed = syntheticContextConfirmed;
    this.capture = { ...zeroCapture() };
    this.renderer = { ...zeroRenderer() };
    this.assist = {
      request_count: 0,
      completed_count: 0,
      failed_count: 0,
      canceled_count: 0,
      rendered_result_count: 0
    };
    this.assistLatencies = [];
    this.lifecycle = { ...zeroLifecycle() };
    this.autosave = { ...zeroAutosave() };
    this.checkpoints = { ...zeroCheckpoints() };
    this.previousEndByTrack = new Map();
    this.captureTracks = new Set();
    this.firstCaptureMs = null;
    this.lastCaptureMs = null;
    this.inFlightAudio = 0;
    this.captureStartedAt = null;
    this.stoppedAt = null;
    this.criticalEventCount = 0;
    this.privacyEventCount = 0;
    this.memorySamples = [];
    this.memoryTimer = null;
    this.memorySampling = false;
    this.outputWritten = false;
  }

  wrapHandler(channel, handler) {
    if (FORBIDDEN_SOAK_CHANNELS.has(channel)) {
      return async () => {
        this.privacyEventCount += 1;
        return { ok: false, error: "This action is unavailable during the privacy-safe soak." };
      };
    }
    if (channel === "meeting:start") return this.wrapStart(handler);
    if (channel === "meeting:audio") return this.wrapAudio(handler);
    if (channel === "meeting:stop") return this.wrapStop(handler);
    if (channel === "meeting:autosave") return this.wrapAutosave(handler);
    if (channel === "meeting:assist-request") return this.wrapAssist(handler);
    if (channel === "meeting:assist-cancel") return this.wrapAssistCancel(handler);
    return handler;
  }

  wrapStart(handler) {
    return async (...args) => {
      const result = await handler(...args);
      if (result?.ok) {
        this.lifecycle.start_success_count += 1;
      }
      return result;
    };
  }

  wrapAudio(handler) {
    return async (event, value, ...args) => {
      this.recordCapturePacket(value);
      this.inFlightAudio += 1;
      try {
        const result = await handler(event, value, ...args);
        if (result?.ok) this.checkpoints.ipc_to_sidecar = true;
        else this.capture.rejected_packet_count += 1;
        return result;
      } catch (error) {
        this.capture.rejected_packet_count += 1;
        throw error;
      } finally {
        this.inFlightAudio -= 1;
      }
    };
  }

  recordCapturePacket(value) {
    const track = value?.track === "system" || value?.track === "microphone"
      ? value.track
      : "invalid";
    const startMs = value?.startMs;
    const endMs = value?.endMs;
    this.capture.packet_count += 1;
    if (track === "system") this.capture.system_packet_count += 1;
    if (track === "microphone") this.capture.microphone_packet_count += 1;
    this.checkpoints.native_capture_started = true;
    this.checkpoints.capture_to_ipc = true;
    this.captureTracks.add(track);
    if (this.captureStartedAt === null) this.captureStartedAt = performance.now();

    if (track === "invalid"
      || !Number.isSafeInteger(startMs)
      || !Number.isSafeInteger(endMs)
      || startMs < 0
      || endMs <= startMs
      || endMs - startMs > PACKET_DURATION_MS) {
      this.capture.gap_count += 1;
      const invalidSpan = Number.isSafeInteger(startMs) && Number.isSafeInteger(endMs)
        ? Math.abs(endMs - startMs)
        : PACKET_DURATION_MS;
      this.capture.max_gap_ms = Math.max(this.capture.max_gap_ms, invalidSpan);
      return;
    }

    const previousEnd = this.previousEndByTrack.get(track);
    if (previousEnd !== undefined && startMs !== previousEnd) {
      const gap = Math.abs(startMs - previousEnd);
      this.capture.gap_count += 1;
      this.capture.max_gap_ms = Math.max(this.capture.max_gap_ms, gap);
    }
    this.previousEndByTrack.set(track, endMs);
    this.firstCaptureMs = this.firstCaptureMs === null ? startMs : Math.min(this.firstCaptureMs, startMs);
    this.lastCaptureMs = this.lastCaptureMs === null ? endMs : Math.max(this.lastCaptureMs, endMs);
  }

  wrapStop(handler) {
    return async (...args) => {
      this.lifecycle.stop_request_count += 1;
      this.lifecycle.capture_drained = this.inFlightAudio === 0;
      const stopRequestedAt = performance.now();
      const result = await handler(...args);
      if (result?.ok) this.stoppedAt = stopRequestedAt;
      await this.refreshRendererState(args[0]?.sender);
      return result;
    };
  }

  wrapAutosave(handler) {
    return async (event, ...args) => {
      this.autosave.request_count += 1;
      const result = await handler(event, ...args);
      if (result?.ok && result.skipped === false) {
        this.autosave.created = true;
        this.autosave.existed_after_stop = await hasMarkdownFile(this.transcriptDirectory);
        await this.refreshRendererState(event?.sender);
        this.checkpoints.renderer_to_autosave = this.renderer.rendered_final_count > 0;
      }
      return result;
    };
  }

  wrapAssist(handler) {
    return async (event, _value, ...args) => {
      this.assist.request_count += 1;
      const startedAt = performance.now();
      const request = createDesktopSoakAssistRequest();
      this.checkpoints.assist_canary_injected = request.question === DESKTOP_SOAK_CONTEXT_CANARY;
      const result = await handler(event, request, ...args);
      if (result?.ok && result.result?.status === "completed") {
        this.assist.completed_count += 1;
        const rendered = await queryRendererUntil(
          event?.sender,
          ({ assist_result: ready, assist_canary_visible: canaryVisible }) => ready && canaryVisible
        );
        this.assistLatencies.push(Math.max(0, performance.now() - startedAt));
        if (rendered.assist_result) this.assist.rendered_result_count += 1;
        this.checkpoints.renderer_to_assist = rendered.assist_result;
        this.checkpoints.assist_canary_rendered = rendered.assist_canary_visible;
      } else if (result?.ok && result.result?.status === "canceled") {
        this.assist.canceled_count += 1;
      } else {
        this.assist.failed_count += 1;
      }
      return result;
    };
  }

  wrapAssistCancel(handler) {
    return async (...args) => {
      const result = await handler(...args);
      if (result?.canceled) this.assist.canceled_count += 1;
      return result;
    };
  }

  observeRendererSend(channel, value) {
    if (channel === "meeting:backend-event") {
      this.renderer.backend_event_count += 1;
      if (value?.type === "final_segment") {
        this.renderer.final_event_count += 1;
        this.checkpoints.sidecar_to_renderer = true;
      }
      if (value?.type === "session_stopped") this.lifecycle.backend_stopped = true;
      if (value?.type === "error"
        || (value?.type === "warning" && CRITICAL_BACKEND_CODES.has(value?.code))) {
        this.criticalEventCount += 1;
      }
    }
  }

  async refreshRendererState(contents) {
    const rendered = await queryRenderer(contents);
    this.renderer.rendered_final_count = Math.max(
      this.renderer.rendered_final_count,
      rendered.final_segments
    );
    this.renderer.reconciliation_mismatch_count = Math.abs(
      this.renderer.final_event_count - this.renderer.rendered_final_count
    );
    this.lifecycle.renderer_finalized = rendered.final_segments > 0;
    this.checkpoints.renderer_reconciled = this.renderer.reconciliation_mismatch_count === 0
      && rendered.final_segments > 0;
  }

  startMemorySampler() {
    const sample = async () => {
      if (this.memorySampling) return;
      this.memorySampling = true;
      try {
        const memory = await collectProcessTreeMemory(process.pid, process.platform);
        if (memory && this.captureStartedAt !== null) {
          this.memorySamples.push({
            elapsed_seconds: Math.max(0, (performance.now() - this.captureStartedAt) / 1_000),
            working_set_mib: memory.working_set_mib,
            private_mib: memory.private_mib
          });
        }
      } finally {
        this.memorySampling = false;
      }
    };
    void sample();
    this.memoryTimer = setInterval(() => void sample(), MEMORY_SAMPLE_INTERVAL_MS);
    this.memoryTimer.unref?.();
  }

  stopMemorySampler() {
    if (this.memoryTimer !== null) clearInterval(this.memoryTimer);
    this.memoryTimer = null;
  }

  buildEvidence() {
    const durationSeconds = this.captureStartedAt !== null && this.stoppedAt !== null
      ? Math.max(0, (this.stoppedAt - this.captureStartedAt) / 1_000)
      : 0;
    this.capture.source_count = this.captureTracks.has("invalid")
      ? Math.max(0, this.captureTracks.size - 1)
      : this.captureTracks.size;
    this.capture.covered_duration_ms = this.firstCaptureMs === null || this.lastCaptureMs === null
      ? 0
      : Math.max(0, this.lastCaptureMs - this.firstCaptureMs);

    return {
      schema_version: DESKTOP_SOAK_SCHEMA_VERSION,
      test: TEST_NAME,
      evidence_kind: EVIDENCE_KIND,
      acceptance_scope: this.scope,
      platform: process.platform,
      runtime: "source",
      sidecar: this.sidecar,
      synthetic_input_confirmed: this.syntheticInputConfirmed,
      synthetic_context_confirmed: this.syntheticContextConfirmed,
      duration_seconds: Math.floor(durationSeconds * 1_000) / 1_000,
      capture: { ...this.capture },
      renderer: { ...this.renderer },
      assist: {
        ...this.assist,
        latency_ms: summarizeLatencies(this.assistLatencies)
      },
      process_tree_memory: summarizeMemorySamples(this.memorySamples, durationSeconds),
      lifecycle: { ...this.lifecycle },
      autosave: { ...this.autosave },
      privacy: {
        critical_event_count: this.criticalEventCount,
        privacy_event_count: this.privacyEventCount
      },
      checkpoints: { ...this.checkpoints }
    };
  }
}

export function createDesktopSoakAssistRequest() {
  return Object.freeze({ question: DESKTOP_SOAK_CONTEXT_CANARY });
}

async function queryRenderer(contents) {
  if (!contents || contents.isDestroyed?.()) {
    return { final_segments: 0, assist_result: false, assist_canary_visible: false };
  }
  try {
    const result = await contents.executeJavaScript(`(() => ({
      final_segments: [...document.querySelectorAll(".transcript-segment")]
        .filter((node) => !node.classList.contains("partial")).length,
      assist_result: (() => {
        const node = document.querySelector("#assist-result-content");
        return Boolean(node && !node.hidden && node.textContent?.trim());
      })(),
      assist_canary_visible: (() => {
        const node = document.querySelector("#assist-result-content");
        return Boolean(node && !node.hidden && node.textContent?.includes(${JSON.stringify(DESKTOP_SOAK_CONTEXT_CANARY)}));
      })()
    }))()`, true);
    return {
      final_segments: Number.isSafeInteger(result?.final_segments) && result.final_segments >= 0
        ? result.final_segments
        : 0,
      assist_result: result?.assist_result === true,
      assist_canary_visible: result?.assist_canary_visible === true
    };
  } catch {
    return { final_segments: 0, assist_result: false, assist_canary_visible: false };
  }
}

async function queryRendererUntil(contents, predicate, timeoutMs = 2_000) {
  const startedAt = performance.now();
  let result = await queryRenderer(contents);
  while (!predicate(result) && performance.now() - startedAt < timeoutMs) {
    await delay(50);
    result = await queryRenderer(contents);
  }
  return result;
}

async function hasMarkdownFile(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"));
  } catch {
    return false;
  }
}

async function collectProcessTreeMemory(rootPid, platform) {
  if (platform === "win32") return collectWindowsProcessTreeMemory(rootPid);
  if (platform === "darwin") return collectMacProcessTreeMemory(rootPid);
  return null;
}

async function collectWindowsProcessTreeMemory(rootPid) {
  const script = [
    "$parents=@{}",
    "Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { $parents[[int]$_.ProcessId]=[int]$_.ParentProcessId }",
    "$wanted=New-Object 'System.Collections.Generic.HashSet[int]'",
    `[void]$wanted.Add(${rootPid})`,
    "$changed=$true",
    "while($changed){$changed=$false;foreach($pair in $parents.GetEnumerator()){if($wanted.Contains($pair.Value)-and -not $wanted.Contains($pair.Key)){[void]$wanted.Add($pair.Key);$changed=$true}}}",
    "$working=[int64]0;$private=[int64]0;$count=0",
    "Get-Process -ErrorAction SilentlyContinue | Where-Object { $wanted.Contains([int]$_.Id) -and $_.Id -ne $PID } | ForEach-Object {$working+=[int64]$_.WorkingSet64;$private+=[int64]$_.PrivateMemorySize64;$count++}",
    "[pscustomobject]@{working=$working;private=$private;count=$count}|ConvertTo-Json -Compress"
  ].join(";");
  try {
    const { stdout } = await execFilePromise("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script
    ]);
    const value = JSON.parse(stdout.trim());
    if (!Number.isFinite(value?.working) || value.working <= 0 || value.count <= 0) return null;
    return {
      working_set_mib: value.working / 1024 / 1024,
      private_mib: Number.isFinite(value.private) ? value.private / 1024 / 1024 : null
    };
  } catch {
    return null;
  }
}

async function collectMacProcessTreeMemory(rootPid) {
  try {
    const { stdout, childPid } = await execFilePromise("ps", ["-axo", "pid=,ppid=,rss="]);
    const rows = stdout.split(/\r?\n/u).map((line) => line.trim().split(/\s+/u).map(Number))
      .filter(([pid, ppid, rss]) => [pid, ppid, rss].every(Number.isFinite));
    const wanted = new Set([rootPid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, ppid] of rows) {
        if (pid !== childPid && wanted.has(ppid) && !wanted.has(pid)) {
          wanted.add(pid);
          changed = true;
        }
      }
    }
    const rssKib = rows.reduce((total, [pid, , rss]) => (
      wanted.has(pid) && pid !== childPid ? total + rss : total
    ), 0);
    if (rssKib <= 0) return null;
    return { working_set_mib: rssKib / 1024, private_mib: null };
  } catch {
    return null;
  }
}

function execFilePromise(command, args) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout, childPid: child.pid });
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runElectronChild(options) {
  const electron = await import("electron");
  const { app, ipcMain } = electron;
  const disposableRoot = process.env.MT_DESKTOP_SOAK_ROOT;
  if (!isDisposableRoot(disposableRoot)) throw new DesktopSoakContractError("invalid_temporary_root");
  const userDataPath = path.join(disposableRoot, "user-data");
  const transcriptDirectory = path.join(disposableRoot, "transcripts");
  app.setPath("userData", userDataPath);

  process.env.MEETING_TRANSCRIBER_FAKE_ASSIST = "1";
  if (options.sidecar === "fake") process.env.MEETING_TRANSCRIBER_FAKE = "1";
  else delete process.env.MEETING_TRANSCRIBER_FAKE;

  const observation = new RuntimeObservation({
    scope: options.scope,
    sidecar: options.sidecar,
    transcriptDirectory,
    syntheticInputConfirmed: options.syntheticInputConfirmed,
    syntheticContextConfirmed: options.syntheticContextConfirmed
  });

  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, handler) => originalHandle(channel, observation.wrapHandler(channel, handler));
  app.on("web-contents-created", (_event, contents) => {
    const originalSend = contents.send.bind(contents);
    contents.send = (channel, ...args) => {
      observation.observeRendererSend(channel, args[0]);
      return originalSend(channel, ...args);
    };
  });
  app.on("will-quit", () => {
    observation.stopMemorySampler();
    if (observation.outputWritten) return;
    observation.outputWritten = true;
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(observation.buildEvidence())}\n`);
  });
  observation.startMemorySampler();

  await import(pathToFileURL(path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../main/index.js"
  )).href);
}

export function createChildOutputObserver() {
  let buffer = "";
  let totalBytes = 0;
  let overflowRecorded = false;
  let unexpectedStdoutLineCount = 0;
  let filePathsEmitted = false;
  let rawEvidence = null;
  let childFailureCode = null;
  let terminalLineCount = 0;

  function observeLine(line) {
    if (line.length === 0) return;
    if (line.startsWith(RESULT_PREFIX)) {
      terminalLineCount += 1;
      if (terminalLineCount !== 1 || rawEvidence !== null || childFailureCode !== null) {
        unexpectedStdoutLineCount += 1;
        return;
      }
      try {
        rawEvidence = JSON.parse(line.slice(RESULT_PREFIX.length));
      } catch {
        rawEvidence = null;
        unexpectedStdoutLineCount += 1;
      }
      filePathsEmitted ||= containsPathLikeText(line);
      return;
    }
    if (line.startsWith(FAILURE_PREFIX)) {
      terminalLineCount += 1;
      const code = line.slice(FAILURE_PREFIX.length);
      if (terminalLineCount !== 1 || !/^[a-z][a-z0-9_]{0,63}$/u.test(code)) {
        unexpectedStdoutLineCount += 1;
        return;
      }
      childFailureCode = code;
      return;
    }
    unexpectedStdoutLineCount += 1;
    filePathsEmitted ||= containsPathLikeText(line);
  }

  function push(chunk) {
    const value = typeof chunk === "string" ? chunk : String(chunk ?? "");
    totalBytes += Buffer.byteLength(value, "utf8");
    if (totalBytes > MAX_CHILD_STDOUT_BYTES && !overflowRecorded) {
      overflowRecorded = true;
      unexpectedStdoutLineCount += 1;
    }
    buffer += value;
    if (Buffer.byteLength(buffer, "utf8") > MAX_CHILD_STDOUT_BYTES) {
      buffer = buffer.slice(-MAX_CHILD_STDOUT_BYTES);
    }
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop() ?? "";
    for (const line of lines) observeLine(line);
  }

  function finish() {
    if (buffer.length > 0) observeLine(buffer);
    buffer = "";
    return snapshot();
  }

  function snapshot() {
    return Object.freeze({
      rawEvidence,
      childFailureCode,
      unexpectedStdoutLineCount,
      filePathsEmitted
    });
  }

  return Object.freeze({ push, finish, snapshot });
}

function containsPathLikeText(value) {
  return /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\[^\s]+|\/(?:Users|home|private|tmp|var)\/)/u
    .test(String(value ?? ""));
}

function emptyPrivacyInspection() {
  return {
    inspection_completed: false,
    artifact_file_count: 0,
    artifact_directory_count: 0,
    artifact_special_count: 0,
    expected_artifact_count: 0,
    unexpected_artifact_count: 0,
    audio_artifact_count: 0,
    transcript_artifact_count: 0,
    context_artifact_count: 0,
    plaintext_artifact_count: 0,
    canary_match_count: 0
  };
}

export async function inspectDisposableRoot(value) {
  if (!isDisposableRoot(value)) throw new DesktopSoakContractError("invalid_temporary_root");
  const root = path.resolve(value);
  const result = emptyPrivacyInspection();
  const pending = [{ absolute: root, segments: [] }];

  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(current.absolute, { withFileTypes: true });
    for (const entry of entries) {
      const segments = [...current.segments, entry.name];
      const absolute = path.join(current.absolute, entry.name);
      const isDirectory = entry.isDirectory();
      const isFile = entry.isFile();
      const expected = isExpectedSoakArtifact(segments, { isDirectory, isFile });

      if (isDirectory) {
        result.artifact_directory_count += 1;
        pending.push({ absolute, segments });
      } else if (isFile) {
        result.artifact_file_count += 1;
        const extension = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTENSIONS.has(extension)) result.audio_artifact_count += 1;
        if (TRANSCRIPT_EXTENSIONS.has(extension)) result.transcript_artifact_count += 1;
        if (["meeting-context-packs.json", "openai-credential.json"].includes(entry.name)) {
          result.context_artifact_count += 1;
        }
        if (await fileContainsCanary(absolute, DESKTOP_SOAK_CONTEXT_CANARY)) {
          result.canary_match_count += 1;
          result.plaintext_artifact_count += 1;
        }
      } else {
        result.artifact_special_count += 1;
      }

      if (expected && (isDirectory || isFile)) result.expected_artifact_count += 1;
      else result.unexpected_artifact_count += 1;
    }
  }

  result.inspection_completed = true;
  return result;
}

function isExpectedSoakArtifact(segments, { isDirectory, isFile }) {
  if (segments.length === 1) {
    return isDirectory && ["transcripts", "user-data"].includes(segments[0]);
  }
  if (segments[0] === "transcripts") {
    return segments.length === 2
      && isFile
      && path.extname(segments[1]).toLowerCase() === ".md";
  }
  if (segments[0] !== "user-data") return false;
  if (segments.length === 2) {
    return (isFile && EXPECTED_USER_DATA_FILES.has(segments[1]))
      || (isDirectory && EXPECTED_USER_DATA_DIRECTORIES.has(segments[1]));
  }
  return EXPECTED_USER_DATA_DIRECTORIES.has(segments[1]);
}

async function fileContainsCanary(filePath, canary) {
  const needles = [Buffer.from(canary, "utf8"), Buffer.from(canary, "utf16le")];
  const overlapBytes = Math.max(...needles.map((needle) => needle.length)) - 1;
  const handle = await fs.open(filePath, "r");
  let carry = Buffer.alloc(0);
  try {
    const chunk = Buffer.alloc(CANARY_SCAN_CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) return false;
      const combined = Buffer.concat([carry, chunk.subarray(0, bytesRead)]);
      if (needles.some((needle) => combined.includes(needle))) return true;
      carry = combined.subarray(Math.max(0, combined.length - overlapBytes));
    }
  } finally {
    await handle.close();
  }
}

async function runParent(options) {
  const confirmations = {
    syntheticInputConfirmed: options.syntheticInputConfirmed,
    syntheticContextConfirmed: options.syntheticContextConfirmed
  };
  if (!["win32", "darwin"].includes(process.platform)) {
    return {
      result: closedFailureResult("unsupported_platform", options.scope, confirmations),
      exitCode: 1
    };
  }
  if (!options.syntheticInputConfirmed) {
    return {
      result: closedFailureResult(
        "synthetic_input_confirmation_required",
        options.scope,
        confirmations
      ),
      exitCode: 1
    };
  }
  if (!options.syntheticContextConfirmed) {
    return {
      result: closedFailureResult(
        "synthetic_context_confirmation_required",
        options.scope,
        confirmations
      ),
      exitCode: 1
    };
  }
  if (options.scope === "release" && options.sidecar !== "real") {
    return {
      result: closedFailureResult("real_sidecar_required", options.scope, confirmations),
      exitCode: 1
    };
  }

  let disposableRoot = null;
  let rawEvidence = null;
  let childFailureCode = null;
  let stderrLineCount = 0;
  let stderrPathDetected = false;
  let exitCode = null;
  let cleanupSucceeded = false;
  let privacyInspection = emptyPrivacyInspection();
  const childOutput = createChildOutputObserver();
  let child = null;
  let interrupted = false;
  let initializationFailed = false;
  const interrupt = () => {
    interrupted = true;
    child?.kill();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    disposableRoot = await fs.mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX));
    const userDataPath = path.join(disposableRoot, "user-data");
    const transcriptDirectory = path.join(disposableRoot, "transcripts");
    await fs.mkdir(userDataPath, { recursive: true });
    await fs.mkdir(transcriptDirectory, { recursive: true });
    await writeSyntheticSettings(userDataPath, transcriptDirectory);

    const electronModule = await import("electron");
    const electronExecutable = electronModule.default;
    child = spawn(electronExecutable, [
      fileURLToPath(import.meta.url),
      "--electron-child",
      "--scope",
      options.scope,
      "--sidecar",
      options.sidecar,
      "--confirm-synthetic-input",
      "--confirm-synthetic-context"
    ], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      env: {
        ...sanitizedEnvironment(process.env),
        MT_DESKTOP_SOAK_ROOT: disposableRoot
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      childOutput.push(chunk);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderrLineCount += Math.max(1, chunk.split(/\r?\n/u).filter(Boolean).length);
      stderrPathDetected ||= containsPathLikeText(chunk);
    });
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    const output = childOutput.finish();
    rawEvidence = output.rawEvidence;
    childFailureCode = output.childFailureCode;
  } catch {
    initializationFailed = true;
    child?.kill();
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    if (disposableRoot !== null) {
      privacyInspection = await inspectDisposableRoot(disposableRoot).catch(
        () => emptyPrivacyInspection()
      );
    }
    cleanupSucceeded = disposableRoot === null
      ? false
      : await removeDisposableRoot(disposableRoot);
  }

  if (initializationFailed) {
    return {
      result: closedFailureResult("desktop_observer_initialization_failed", options.scope, {
        ...confirmations,
        cleanupSucceeded
      }),
      exitCode: 1
    };
  }

  if (!rawEvidence) {
    return {
      result: closedFailureResult(
        interrupted
          ? "native_observation_interrupted"
          : (childFailureCode ?? "native_observation_missing"),
        options.scope,
        {
          ...confirmations,
          cleanupSucceeded,
          retentionUncertain: !cleanupSucceeded && disposableRoot !== null
        }
      ),
      exitCode: 1
    };
  }

  rawEvidence.lifecycle.app_exit_clean = exitCode === 0;
  rawEvidence.autosave.cleanup_succeeded = cleanupSucceeded;
  const output = childOutput.snapshot();
  const childCriticalCount = Number.isSafeInteger(rawEvidence.privacy?.critical_event_count)
    ? rawEvidence.privacy.critical_event_count
    : 1;
  const childPrivacyCount = Number.isSafeInteger(rawEvidence.privacy?.privacy_event_count)
    ? rawEvidence.privacy.privacy_event_count
    : 1;
  const retentionUncertain = !cleanupSucceeded && !privacyInspection.inspection_completed;
  rawEvidence.privacy = {
    critical_event_count: childCriticalCount + stderrLineCount,
    privacy_event_count: childPrivacyCount,
    ...privacyInspection,
    unexpected_stdout_line_count: output.unexpectedStdoutLineCount,
    audio_retained: !cleanupSucceeded
      && (retentionUncertain || privacyInspection.audio_artifact_count > 0),
    transcript_retained: !cleanupSucceeded
      && (retentionUncertain || privacyInspection.transcript_artifact_count > 0),
    context_retained: !cleanupSucceeded
      && (retentionUncertain || privacyInspection.context_artifact_count > 0),
    file_paths_emitted: output.filePathsEmitted || stderrPathDetected
  };
  try {
    const result = evaluateDesktopSoak(rawEvidence);
    return { result, exitCode: result.passed ? 0 : 1 };
  } catch {
    return {
      result: closedFailureResult("invalid_native_observation", options.scope, {
        ...confirmations,
        cleanupSucceeded,
        retentionUncertain: !cleanupSucceeded && disposableRoot !== null
      }),
      exitCode: 1
    };
  }
}

function sanitizedEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key, value]) => (
    typeof value === "string" && !SENSITIVE_ENVIRONMENT_KEY.test(key)
  )));
}

async function writeSyntheticSettings(userDataPath, transcriptDirectory) {
  const settings = {
    model: "small.en",
    language: "en",
    diarization: false,
    translation: "off",
    transcriptDirectory,
    autoSave: true,
    closeBehavior: "quit",
    minimizeToTray: false,
    providerMode: "off",
    openAIModel: "gpt-5.6-luna"
  };
  await fs.writeFile(path.join(userDataPath, "settings.json"), `${JSON.stringify(settings)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
}

function isDisposableRoot(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  const resolved = path.resolve(value);
  const temporary = path.resolve(os.tmpdir());
  return path.basename(resolved).startsWith(TEMP_PREFIX)
    && resolved.startsWith(`${temporary}${path.sep}`);
}

export async function removeDisposableRoot(value) {
  if (!isDisposableRoot(value)) return false;
  try {
    await fs.rm(path.resolve(value), { recursive: true, force: true });
    try {
      await fs.access(path.resolve(value));
      return false;
    } catch {
      return true;
    }
  } catch {
    return false;
  }
}

function parseOptions(argv) {
  const options = {
    electronChild: false,
    scope: "smoke",
    sidecar: "real",
    syntheticInputConfirmed: false,
    syntheticContextConfirmed: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--electron-child") options.electronChild = true;
    else if (argument === "--confirm-synthetic-input") options.syntheticInputConfirmed = true;
    else if (argument === "--confirm-synthetic-context") options.syntheticContextConfirmed = true;
    else if (argument === "--scope") options.scope = argv[++index];
    else if (argument === "--sidecar") options.sidecar = argv[++index];
    else throw new DesktopSoakContractError("invalid_command_argument");
  }
  assertEnum(options.scope, ["smoke", "release"], "invalid_acceptance_scope");
  assertEnum(options.sidecar, ["real", "fake"], "invalid_sidecar");
  return options;
}

async function main() {
  let options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch {
    process.stdout.write(`${JSON.stringify(closedFailureResult("invalid_command_argument"))}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.electronChild || process.versions.electron) {
    try {
      await runElectronChild(options);
    } catch {
      process.stdout.write(`${FAILURE_PREFIX}electron_observer_initialization_failed\n`);
      process.exitCode = 1;
    }
    return;
  }

  try {
    const { result, exitCode } = await runParent(options);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify(
      closedFailureResult("desktop_observer_initialization_failed", options.scope)
    )}\n`);
    process.exitCode = 1;
  }
}

const isEntrypoint = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) await main();
