import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DESKTOP_SOAK_CONTEXT_CANARY,
  DesktopSoakContractError,
  closedFailureResult,
  createChildOutputObserver,
  createDesktopSoakAssistRequest,
  evaluateDesktopSoak,
  inspectDisposableRoot,
  summarizeMemorySamples
} from "../tools/desktop-soak.mjs";

test("the native soak replaces the operator prompt with one fixed synthetic Assist canary", () => {
  const request = createDesktopSoakAssistRequest();

  assert.deepEqual(request, { question: DESKTOP_SOAK_CONTEXT_CANARY });
  assert.equal(Object.isFrozen(request), true);
});

test("strict native release evidence passes only with the complete 60-minute desktop path", () => {
  const result = evaluateDesktopSoak(releaseEvidence());

  assert.equal(result.contract_passed, true);
  assert.equal(result.passed, true);
  assert.equal(result.acceptance_scope, "release");
  assert.equal(result.duration_seconds, 3_600);
  assert.deepEqual(result.acceptance_failures, []);
  assert.equal(result.capture.packet_count, 18_000);
  assert.equal(result.assist.latency_ms.count, 1);
  assert.equal(result.process_tree_memory.sample_count, 720);
  assert.equal(result.stop_and_drain.capture_drained, true);
  assert.equal(result.autosave.cleanup_succeeded, true);
});

test("a valid short native smoke is contract evidence but can never become a release pass", () => {
  const evidence = releaseEvidence();
  evidence.acceptance_scope = "smoke";
  evidence.sidecar = "fake";
  evidence.duration_seconds = 30;
  evidence.capture.packet_count = 150;
  evidence.capture.system_packet_count = 150;
  evidence.capture.covered_duration_ms = 30_000;
  evidence.process_tree_memory.sample_count = 6;
  evidence.process_tree_memory.stable_first_count = 0;
  evidence.process_tree_memory.stable_last_count = 0;
  evidence.process_tree_memory.working_set_growth_mib = null;
  evidence.process_tree_memory.private_growth_mib = null;

  const result = evaluateDesktopSoak(evidence);

  assert.equal(result.contract_passed, true);
  assert.equal(result.passed, false);
  assert.equal(result.acceptance_scope, "smoke");
  assert.equal(result.acceptance_failures.includes("release_scope_required"), true);
  assert.equal(result.acceptance_failures.includes("minimum_duration_not_met"), true);
  assert.equal(result.acceptance_failures.includes("real_sidecar_required"), true);
});

test("release scope rejects a run even one second shorter than 60 minutes", () => {
  const evidence = releaseEvidence();
  evidence.duration_seconds = 3_599;
  evidence.capture.covered_duration_ms = 3_599_000;

  const result = evaluateDesktopSoak(evidence);

  assert.equal(result.passed, false);
  assert.equal(result.acceptance_failures.includes("minimum_duration_not_met"), true);
});

test("release scope rejects a fractional sub-hour boundary without rounding it into a pass", () => {
  const evidence = releaseEvidence();
  evidence.duration_seconds = 3_599.999;
  evidence.capture.covered_duration_ms = 3_599_999;

  const result = evaluateDesktopSoak(evidence);

  assert.equal(result.passed, false);
  assert.equal(result.acceptance_failures.includes("minimum_duration_not_met"), true);
});

test("every real path checkpoint is fail closed", () => {
  for (const checkpoint of Object.keys(releaseEvidence().checkpoints)) {
    const evidence = releaseEvidence();
    evidence.checkpoints[checkpoint] = false;

    const result = evaluateDesktopSoak(evidence);

    assert.equal(result.passed, false, checkpoint);
    assert.equal(
      result.acceptance_failures.includes(`checkpoint_${checkpoint}_missing`),
      true,
      checkpoint
    );
  }
});

test("sensitive or unknown evidence fields are rejected and never reflected in failure output", () => {
  const sentinelTranscript = "Confidential acquisition target";
  const sentinelPath = "C:\\Users\\someone\\meeting-secret.md";
  const evidence = {
    ...releaseEvidence(),
    transcript_text: sentinelTranscript,
    transcript_path: sentinelPath
  };

  let contractError;
  assert.throws(
    () => evaluateDesktopSoak(evidence),
    (error) => {
      contractError = error;
      return error instanceof DesktopSoakContractError
        && error.code === "invalid_evidence_shape";
    }
  );

  const serialized = JSON.stringify(closedFailureResult(contractError.message, "release"));
  assert.equal(serialized.includes(sentinelTranscript), false);
  assert.equal(serialized.includes(sentinelPath), false);
  assert.equal(serialized.includes("Desktop soak evidence"), false);
  assert.equal(serialized.includes("desktop_soak_failed"), true);
});

test("nested paths and transcript payloads cannot enter the aggregate schema", () => {
  for (const [section, key, value] of [
    ["capture", "audio", "raw-pcm"],
    ["renderer", "transcript", "synthetic-but-still-forbidden"],
    ["autosave", "path", "/tmp/meeting.md"],
    ["assist", "context", "private pack"]
  ]) {
    const evidence = releaseEvidence();
    evidence[section][key] = value;
    assert.throws(
      () => evaluateDesktopSoak(evidence),
      (error) => error instanceof DesktopSoakContractError
        && error.code === `invalid_${section}_shape`
    );
  }
});

test("memory aggregation accepts negative growth and calculates stable windows without paths", () => {
  const samples = [];
  for (let elapsed = 0; elapsed <= 3_600; elapsed += 5) {
    samples.push({
      elapsed_seconds: elapsed,
      working_set_mib: elapsed < 1_800 ? 900 : 850,
      private_mib: elapsed < 1_800 ? 700 : 640
    });
  }

  const summary = summarizeMemorySamples(samples, 3_600);

  assert.equal(summary.available, true);
  assert.equal(summary.sample_count, 721);
  assert.equal(summary.stable_first_count >= 60, true);
  assert.equal(summary.stable_last_count >= 60, true);
  assert.equal(summary.working_set_growth_mib, -50);
  assert.equal(summary.private_growth_mib, -60);
  assert.equal(JSON.stringify(summary).includes("path"), false);
});

test("privacy, autosave cleanup, memory, and renderer mismatches remain release gates", () => {
  const evidence = releaseEvidence();
  evidence.privacy.privacy_event_count = 1;
  evidence.autosave.cleanup_succeeded = false;
  evidence.process_tree_memory.working_set_growth_mib = 512.1;
  evidence.renderer.reconciliation_mismatch_count = 1;

  const result = evaluateDesktopSoak(evidence);

  assert.equal(result.contract_passed, false);
  assert.equal(result.passed, false);
  assert.equal(result.acceptance_failures.includes("privacy_event_detected"), true);
  assert.equal(result.acceptance_failures.includes("temporary_state_cleanup_failed"), true);
  assert.equal(result.acceptance_failures.includes("process_tree_memory_growth_exceeded"), true);
  assert.equal(result.acceptance_failures.includes("renderer_reconciliation_mismatch"), true);
});

test("unexpected child stdout and path-shaped output fail the aggregate privacy contract", () => {
  const observer = createChildOutputObserver();
  observer.push("debug transcript at C:\\private\\meeting.txt\n");
  const observed = observer.finish();

  assert.equal(observed.unexpectedStdoutLineCount, 1);
  assert.equal(observed.filePathsEmitted, true);

  const evidence = releaseEvidence();
  evidence.privacy.unexpected_stdout_line_count = observed.unexpectedStdoutLineCount;
  evidence.privacy.file_paths_emitted = observed.filePathsEmitted;
  const result = evaluateDesktopSoak(evidence);
  assert.equal(result.passed, false);
  assert.equal(result.acceptance_failures.includes("unexpected_stdout_detected"), true);
  assert.equal(result.acceptance_failures.includes("file_path_emitted"), true);
});

test("disposable-root inspection detects unexpected canary artifacts without returning paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "meeting-transcriber-desktop-soak-"));
  try {
    await mkdir(path.join(root, "user-data"), { recursive: true });
    await mkdir(path.join(root, "transcripts"), { recursive: true });
    await writeFile(path.join(root, "user-data", "settings.json"), "{}\n", "utf8");
    await writeFile(path.join(root, "transcripts", "meeting.md"), "synthetic\n", "utf8");
    await writeFile(
      path.join(root, "rogue.log"),
      `${DESKTOP_SOAK_CONTEXT_CANARY}\n`,
      "utf8"
    );

    const inspection = await inspectDisposableRoot(root);
    assert.equal(inspection.inspection_completed, true);
    assert.equal(inspection.transcript_artifact_count, 1);
    assert.equal(inspection.unexpected_artifact_count, 1);
    assert.equal(inspection.canary_match_count, 1);
    assert.equal(inspection.plaintext_artifact_count, 1);
    assert.equal(JSON.stringify(inspection).includes(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cross-field counts cannot be forged into a release pass", () => {
  const evidence = releaseEvidence();
  evidence.renderer.rendered_final_count = 23;
  evidence.renderer.reconciliation_mismatch_count = 0;
  evidence.assist.request_count = 2;
  evidence.assist.completed_count = 2;
  evidence.assist.rendered_result_count = 2;
  evidence.assist.latency_ms.count = 2;

  const result = evaluateDesktopSoak(evidence);

  assert.equal(result.passed, false);
  assert.equal(result.acceptance_failures.includes("renderer_final_count_mismatch"), true);
  assert.equal(result.acceptance_failures.includes("renderer_reconciliation_metric_invalid"), true);
  assert.equal(result.acceptance_failures.includes("single_assist_request_required"), true);
});

test("an unverified cleanup after missing native evidence reports conservative transcript retention", () => {
  const result = closedFailureResult("native_observation_missing", "release", {
    cleanupSucceeded: false,
    syntheticInputConfirmed: true,
    syntheticContextConfirmed: true,
    retentionUncertain: true
  });

  assert.equal(result.passed, false);
  assert.equal(result.synthetic_input_confirmed, true);
  assert.equal(result.synthetic_context_confirmed, true);
  assert.equal(result.autosave.cleanup_succeeded, false);
  assert.equal(result.retention.transcript, true);
});

function releaseEvidence() {
  return {
    schema_version: 1,
    test: "native_electron_desktop_soak",
    evidence_kind: "native_desktop_observation",
    acceptance_scope: "release",
    platform: "win32",
    runtime: "source",
    sidecar: "real",
    synthetic_input_confirmed: true,
    synthetic_context_confirmed: true,
    duration_seconds: 3_600,
    capture: {
      packet_count: 18_000,
      system_packet_count: 18_000,
      microphone_packet_count: 0,
      source_count: 1,
      covered_duration_ms: 3_600_000,
      gap_count: 0,
      max_gap_ms: 0,
      rejected_packet_count: 0
    },
    renderer: {
      backend_event_count: 300,
      final_event_count: 24,
      rendered_final_count: 24,
      reconciliation_mismatch_count: 0
    },
    assist: {
      request_count: 1,
      completed_count: 1,
      failed_count: 0,
      canceled_count: 0,
      rendered_result_count: 1,
      latency_ms: { count: 1, p50: 120, p95: 120, max: 120 }
    },
    process_tree_memory: {
      available: true,
      sample_count: 720,
      stable_first_count: 100,
      stable_last_count: 100,
      working_set_peak_mib: 1_250,
      working_set_growth_mib: 24,
      private_available: true,
      private_peak_mib: 1_000,
      private_growth_mib: 18
    },
    lifecycle: {
      start_success_count: 1,
      stop_request_count: 1,
      capture_drained: true,
      backend_stopped: true,
      renderer_finalized: true,
      app_exit_clean: true
    },
    autosave: {
      request_count: 1,
      created: true,
      existed_after_stop: true,
      cleanup_succeeded: true
    },
    privacy: {
      critical_event_count: 0,
      privacy_event_count: 0,
      inspection_completed: true,
      artifact_file_count: 1,
      artifact_directory_count: 2,
      artifact_special_count: 0,
      expected_artifact_count: 3,
      unexpected_artifact_count: 0,
      audio_artifact_count: 0,
      transcript_artifact_count: 1,
      context_artifact_count: 0,
      plaintext_artifact_count: 0,
      canary_match_count: 0,
      unexpected_stdout_line_count: 0,
      audio_retained: false,
      transcript_retained: false,
      context_retained: false,
      file_paths_emitted: false
    },
    checkpoints: {
      native_capture_started: true,
      capture_to_ipc: true,
      ipc_to_sidecar: true,
      sidecar_to_renderer: true,
      renderer_reconciled: true,
      renderer_to_autosave: true,
      renderer_to_assist: true,
      assist_canary_injected: true,
      assist_canary_rendered: true
    }
  };
}
