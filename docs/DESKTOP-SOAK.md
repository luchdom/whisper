# Native desktop soak

`desktop/tools/desktop-soak.mjs` is a privacy-safe, operator-driven observer for the real Electron desktop path. It launches the source application, instruments only aggregate counters at the main-process boundary, and observes:

`native capture -> renderer packetization -> Electron IPC -> source sidecar -> backend events -> renderer reconciliation -> autosave and Assist`

Native screen/audio permissions and the selected audio source cannot be automated reliably across Windows and macOS. An operator must use the visible application and permission dialogs. The harness does not substitute a simulated pass for those actions.

## Privacy boundary

The parent process creates a uniquely named directory below the operating-system temp directory. The child Electron application uses that directory for its complete `userData` profile and transcript destination. The parent removes the directory after Electron exits and verifies that it is gone.

The harness:

- never emits PCM, transcript text, translated text, Assist questions, Assist responses, context-pack content, segment IDs, or file paths in its evidence;
- temporarily stores the app's synthetic transcript and temporary destination setting inside the disposable root so the real autosave path is exercised, then requires verified deletion before release acceptance;
- classifies child stdout/stderr without forwarding its content, fails on every unexpected line, and emits one aggregate JSON document after cleanup;
- removes environment variables whose names look like credentials, passwords, OAuth material, secrets, sessions, or tokens before starting Electron;
- uses the repository's development fake Assist provider, an empty temporary context-pack store, and provider mode Off, so the soak makes no hosted Assist request;
- replaces the operator's one Assist prompt at the main-process IPC boundary with a fixed synthetic canary, requires that canary to complete the fake-provider round trip and appear in the renderer, then scans every disposable-profile file for its UTF-8 or UTF-16 representation before cleanup;
- blocks clipboard import, manual copy/save/export, provider-link, provider-revocation, and context-pack mutation handlers for the duration of the run;
- preconfigures `small.en`, English input, translation Off, diarization Off, automatic save On, and a temporary transcript destination;
- retains the ordinary model cache. Model files contain no meeting data and are intentionally not redownloaded and deleted on every run.

Trying a blocked action increments the privacy-event count and prevents a release pass. Any child stderr or unexpected stdout increments a failure count; path-shaped output is recorded only as a boolean. Before cleanup, the parent recursively inventories the disposable root using allowlisted artifact classes and aggregate counts, scans every file regardless of name or extension for the injected Assist canary, and rejects audio, context, special, unexpected, or canary-bearing artifacts. It never emits filenames, paths, file contents, or the operator's discarded prompt. Cleanup is then verified separately; investigate failures instead of overriding them.

## Prerequisites

- Run from the repository root on Windows or macOS.
- Complete the normal source bootstrap first.
- Close every other Meeting Transcriber window. The app's single-instance lock makes a second copy fail closed.
- Prepare a live, non-confidential synthetic speech source. For example, use local OS text-to-speech or a browser speech generator reading an invented meeting script. Do not use a real meeting, customer data, work documents, private context, or a prerecorded confidential call.
- For a release run, keep that synthetic source playing in real time for longer than 60 minutes. The harness measures actual time between the app's one successful Start and one successful Stop; a shorter or accelerated run cannot pass.

The explicit `--confirm-synthetic-input` and `--confirm-synthetic-context` flags are operator attestations that both the played speech and the Assist interaction are invented and non-confidential. The harness discards the typed Assist prompt at the main-process boundary and substitutes its fixed synthetic canary. The flags do not manufacture native evidence: packet continuity, renderer delivery, the canary's Assist round trip and absence from disk, autosave, process-tree memory, stop/drain, cleanup, and app exit are still measured by the wrapper.

## Smoke run

The fastest UI/lifecycle smoke uses the development fake sidecar:

```powershell
node .\desktop\tools\desktop-soak.mjs --scope smoke --sidecar fake --confirm-synthetic-input --confirm-synthetic-context
```

```bash
node ./desktop/tools/desktop-soak.mjs --scope smoke --sidecar fake --confirm-synthetic-input --confirm-synthetic-context
```

Use `--sidecar real` instead to exercise the real source sidecar during a smoke. A smoke result can have `contract_passed: true`, but `passed` is always false and the command exits nonzero because it is not release evidence. Expected acceptance failures include `release_scope_required` and `minimum_duration_not_met`; a fake-sidecar smoke also includes `real_sidecar_required`.

## Release-scope run

Start the strict observer with the real source sidecar:

```powershell
node .\desktop\tools\desktop-soak.mjs --scope release --sidecar real --confirm-synthetic-input --confirm-synthetic-context
```

```bash
node ./desktop/tools/desktop-soak.mjs --scope release --sidecar real --confirm-synthetic-input --confirm-synthetic-context
```

Then complete exactly this visible workflow:

1. Choose Start transcription and select the synthetic system-audio source in the native capture picker. You may include the microphone only if it carries synthetic input too.
2. Confirm that finalized transcript rows appear. The exact words and transcription quality are outside this payload-free stability gate.
3. Open Assist after finalized context exists, enter an invented question such as “What is a concise answer to the synthetic budget question?”, approve the meeting-scoped disclosure, and choose Send exactly once. The local fake provider must render one result.
4. Keep the meeting active beyond 60 wall-clock minutes. Do not restart the session, change devices, import context, copy/export, or manually save during this strict run.
5. Choose Stop transcription exactly once. Wait for final renderer reconciliation and the automatic-save confirmation.
6. Quit the application. The parent waits for process exit, removes and verifies the disposable state, and then prints the aggregate JSON result.

If permission is denied, capture is interrupted, the model is not ready, the sidecar fails, or the application crashes, quit normally when possible. The resulting JSON remains a failure report; do not edit it into a pass.

## Acceptance contract

Top-level `passed: true` requires all of the following in one native observation:

- `acceptance_scope` is `release`, the measured duration is at least 3,600 seconds, and the sidecar is real;
- both synthetic-input and synthetic-context conditions are confirmed;
- capture supplies continuous, accepted 200 ms packets for the measured duration with no timestamp gaps;
- the wrapper observes backend events and finalized events sent to the workspace, and the rendered final-row count reconciles exactly;
- exactly one synthetic Assist request completes within the latency bounds, with the harness-injected canary observed both at the production handler boundary and in the rendered fake-provider result;
- at least 600 process-tree memory samples exist, with at least 60 samples in both the stable first and stable last windows, and median working/private growth is no more than 512 MiB;
- exactly one successful start and stop occur, all capture IPC is drained before stop, the backend reports stopped, the renderer is finalized, and Electron exits with code zero;
- exactly one autosave is created, exists after stop, and disappears when the disposable root is removed;
- every path checkpoint is observed and critical/privacy/retention counts remain zero.

macOS reports process-tree resident memory because the portable `ps` interface does not expose the Windows-style private-memory counter. Windows reports both resident and private process-tree memory. A missing memory source fails closed.

The output schema is exact. Unknown fields—including `text`, `audio`, `context`, or `path` payloads at any level—are rejected rather than copied into a failure message. Acceptance failures are fixed reason codes only.

## What this does not prove

This harness launches and instruments the source Electron application and its source sidecar boundary. It does not instrument an already installed or signed binary, so installer, code-signing, notarization, upgrade, and clean-machine behavior remain separate distribution gates.

A passing run establishes sustained desktop-path delivery and lifecycle evidence for the specific operating system and hardware used. It does not establish transcription accuracy, diarization accuracy, translation quality, native behavior on the other operating system, overlay invisibility, or compatibility with every meeting application. Record Windows and macOS results separately and never infer one platform from the other.

Deterministic tests validate the schema, privacy redaction, memory aggregation, every checkpoint, and short-run rejection:

```powershell
node --test .\desktop\test\desktop-soak-contract.test.js
```

```bash
node --test ./desktop/test/desktop-soak-contract.test.js
```

Those tests are contract evidence only. They are not a completed native 60-minute soak.
