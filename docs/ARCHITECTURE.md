# Architecture and delivery boundary

## Current data flow

```text
system loopback ─> AudioWorklet ─> mono 16 kHz PCM ─> Electron IPC ─> Python JSONL sidecar
                                                                      ├─> faster-whisper text
                                                                      ├─> optional speaker embedding/clustering
microphone ─────> AudioWorklet ─> mono 16 kHz PCM ────────────────────┘
                                                                      │
                                                                      ├─> partial events ────────────────> transcript UI
                                                                      │
                                                                      └─> finalized eligible English
                                                                           └─> optional local pt-BR translation
                                                                                └─> one atomic final event ─> UI/export
```

The two audio sources stay separate from capture through inference. That gives a truthful `You` versus `Meeting audio` distinction, preserves source overlap, and avoids destroying source information by mixing. Optional local speaker clustering adds provisional anonymous IDs only to silence-delimited system-audio utterances.

## Responsibilities

### Desktop main process

- Owns the Electron window, OS media permissions, system-loopback selection, settings persistence, safe local export, and sidecar lifecycle.
- Validates every renderer command and every sidecar event at the IPC boundary.
- Loads the bundled model manifest and exposes only a sanitized catalog data-transfer object (DTO) containing public IDs and presentation metadata. Repository revisions, URLs, hashes, and local cache paths do not cross into the renderer.
- Relays only allowlisted model-preparation phases; app-owned cache paths and download internals never cross into the renderer.
- Owns native file/folder pickers and every file write. The sandboxed renderer may display the selected transcript-directory path, but it cannot submit an arbitrary path or perform filesystem operations.
- Does not log stderr, PCM, transcript text, or participant data.

### Sandboxed renderer

- Requests capture only after the visible start action.
- Stops Chromium's required display video track immediately; video frames are never read or stored.
- Uses an `AudioWorklet` and deterministic streaming resampler to produce signed 16-bit little-endian, mono, 16 kHz packets.
- Builds the model picker from the sanitized catalog instead of maintaining a second model allowlist.
- Reconciles stable segment IDs by increasing revision, assigns first-seen friendly labels, applies session-local manual aliases, preserves original text as canonical, and exports finalized text only.
- Presents model preparation as accessible indeterminate progress and clears it when the engine becomes ready or unavailable.

### Python sidecar

- Accepts bounded UTF-8 JSON Lines commands over stdin and emits validated events over stdout.
- Segments each source independently using RMS-based voice activity, pre-roll, silence endpointing, and a maximum utterance length.
- Gives every transcript event an immutable session ID so late output from an old process cannot enter a new meeting.
- Holds queued and active inference PCM within a 32 MiB budget. It coalesces optional partials first and fails closed with an explicit overload event before accepting a final that would exceed the budget.
- Loads `faster-whisper` lazily, resolves every model through the strict manifest, and keeps inference behind a small `configure / prepare / transcribe / close` interface.
- Emits cache-check, download, verification, local-initialization, optional speaker-preparation, and optional translation download/conversion/preparation phases without exposing filesystem paths or claiming an unavailable aggregate percentage.
- Optionally loads a local WeSpeaker ONNX embedding model through `sherpa-onnx`, clusters up to 16 meeting speakers in memory, and fails soft to source labels if that model is unavailable.
- Optionally loads the verified CTranslate2 English-to-pt-BR model, translates finalized eligible English only, and preserves the original if translation preparation or inference fails.

The protocol is documented in [backend/README.md](../backend/README.md).

## Model manifest trust boundary

`backend/src/meeting_transcriber/model_manifest.json` is the single schema-v1 trust source for 14 ASR choices, the anonymous speaker model, and the local translation model. The manifest is packaged with the backend source; model artifacts are not bundled.

Every ASR entry contains an allowlisted public ID, an explicit Hugging Face repository, a full 40-character commit revision, and the exact byte size and SHA-256 digest of every required runtime file. The provisioner never passes a mutable short name to Faster-Whisper.

Provisioning follows one fail-closed path:

1. Resolve only a known manifest ID.
2. Acquire an operating-system lock for that model in the app-owned model root.
3. Verify every file on every cache hit; a directory name or prior download is not proof of integrity.
4. On a miss, download only the manifest allowlist into an app-owned staging directory at the pinned revision.
5. Check every size and SHA-256 digest before atomically promoting the directory.
6. Refuse to load on any mismatch. There is no fallback to a mutable upstream revision or global cache entry.

Selecting a model updates settings only. Network access does not begin until **Start transcription** needs an unprovisioned model. The UI reports cache checking, downloading, and hashing as separate phases; multi-gigabyte models can spend visible time in verification.

The speaker entry uses a fixed sherpa-onnx commit and release asset plus an exact file size and SHA-256 digest. The translation entry pins the Helsinki upstream revision, the dated 863,398,393-byte Tatoeba archive, every archive member, the CTranslate2 version and quantization, and the expected converted Windows x64 outputs.

The main process exposes a sanitized catalog DTO for display and settings validation. The renderer can choose a known ID, but it cannot supply a repository, revision, URL, local path, or checksum.

## Translation semantics and ordering

Translation mode is `off` by default. The only current enabled mode is local English to Brazilian Portuguese on Windows x64.

Original ASR text is always canonical. Replaceable partials have no translation. A finalized segment is eligible only when English is explicitly selected or automatic detection reports English with confidence of at least `0.80`. Eligible final text is translated with the `>>pob<<` target token, while non-English or low-confidence text remains unchanged.

The current sidecar translates synchronously inside the inference worker before it emits that segment's final event. Original and translated text therefore arrive atomically in one revision, and stop/autosave cannot overtake a pending translation. This simple ordering also means translation latency delays final-event emission and keeps that job accounted in the bounded queue. A future parallel translation stage must preserve the same join and ordering guarantees before replacing it.

Translation failures are fail-soft: the sidecar reports translation as unavailable once, keeps the original text, and allows transcription and original-only export to continue. Markdown output writes English first and a clearly labeled pt-BR translation below it when one exists.

## Streaming and speaker semantics

The app is live but not a stateful streaming-ASR implementation. It repeatedly decodes the active utterance to provide provisional text, then performs a final decode at silence or stop. The UI therefore treats partial text as replaceable and persists only final revisions.

Speaker assignment uses the same pre-segmented utterance. The first partial assignment stays stable through the final revision; a finalized embedding updates its cluster centroid. This avoids visible label churn, but it is not overlap-aware diarization. Similar voices can merge, one voice can split, and a no-pause handoff can remain one segment. Labels reset each meeting and never imply a persistent identity.

This boundary lets a future engine use a native streaming recognizer, local WebSocket service, or post-meeting high-accuracy pass without changing capture or transcript reconciliation.

## Privacy and safety invariants

- Capture is explicit and visibly indicated. A later tray mode may minimize the window, but must keep an unmistakable recording badge, timer, and stop action.
- Audio is memory-only and is never sent to a transcription API.
- A selected model can access the network only for initial provisioning. Every later startup re-verifies the app-owned local artifact and can remain offline when verification succeeds.
- Speaker embeddings are biometric-derived data. They remain memory-only and are cleared at meeting end; only anonymous IDs and user-entered display aliases reach transcript events/files.
- Automatic saving is explicit, final-text-only, main-process-owned, collision-safe, and atomic. A post-stop speaker rename refreshes only the current app-owned autosave file.
- Translation never replaces or mutates the original transcript. The original remains available when translation is disabled, unsupported, or fails.
- A final ASR failure or inference overload produces a non-success session reason. The main process then blocks autosave so an incomplete transcript is never announced as successfully saved.
- Voice identity, voice enrollment, cloud summaries, and meeting advice require separate opt-in designs.
- Windows endpoint loopback can include notifications and unrelated application sounds. Process-scoped capture is a later privacy improvement.

## Platform boundary

Windows 11 capture and local inference have been exercised in this workspace. The built-in macOS system-audio path uses Electron's native picker and is gated to macOS 15 or newer; microphone-only capture remains available below that gate. macOS capture behavior, Apple Silicon performance, signing, notarization, and packaging remain unverified until tested on actual macOS hardware.

Local translation is currently enabled only for Windows x64. The INT8 converted output was reproduced twice with identical hashes on that platform. The macOS setting stays unavailable until the conversion outputs and runtime behavior are verified on Intel and Apple Silicon as applicable; the application does not assume that Windows conversion hashes are portable.

The source repository provides repo-relative, idempotent Windows and macOS bootstrap scripts. After the user installs Node.js 22+, pnpm 10+, and official CPython 3.12.x, one command creates `backend/.venv`, installs the constrained editable backend, verifies the pinned CTranslate2 and SentencePiece imports, installs the frozen pnpm lockfile, and runs the source checks. This source-bootstrap boundary is separate from distribution: the current Electron package includes backend source, constraints, and the manifest, not a self-contained Python runtime, native Python dependencies, bootstrap scripts, or models. `pnpm run pack` is therefore a developer package check, not a standalone-installer acceptance gate.

## Validation boundary

The automated soak compresses 60 virtual minutes into a deterministic queue/state regression and reports its limitation in its output. It verifies bounded queue accounting and drainage, not real-time ASR throughput, translation throughput, meeting-capture durability, or speaker accuracy. A separate strict release-scope wall-clock backend run fed the first hour of a public multi-speaker recording through the production JSONL sidecar at the application's 200 ms packet cadence with real `small.en` inference, online diarization, and local English-to-pt-BR translation. That Windows sidecar gate now passes, but it bypasses desktop system-audio capture, Electron IPC, renderer reconciliation, and autosave. A real 60-minute Windows desktop meeting and a real 60-minute macOS meeting with working devices remain required.

A one-sentence English-to-pt-BR smoke completed in 0.109 seconds on the validated Windows machine. The strict wall-clock run then delivered all 18,000 real-time packets, emitted a non-empty pt-BR-labeled payload for all 287 non-empty final segments, skipped one empty final, emitted no warnings or errors, and stopped the decoder and sidecar cleanly with empty stderr. Resident memory peaked at 1,341.5 MiB, while private-memory medians decreased by 50.1 MiB from the first stable window to the last; final-segment latency was 5.835 seconds at p50, 7.985 seconds at p95, and 9.535 seconds maximum. The evaluator returned `passed: true`, `acceptance_scope: release`, and no acceptance failures. This completes the strict Windows backend translation-pipeline gate, but it does not independently assess Portuguese meaning. Windows desktop capture/autosave and macOS runtime gates remain outstanding, and the ten anonymous clusters produced during the source do not establish speaker-label accuracy.

## Staged roadmap

1. Run a real 60-minute Windows desktop meeting with English-to-pt-BR translation enabled through system-audio capture, Electron IPC, renderer reconciliation, and autosave; measure end-to-end latency, dropped-audio behavior, and anonymous-label stability.
2. Validate macOS system audio, microphone capture, speaker clustering, ASR performance, and deterministic local translation conversion/runtime behavior on actual macOS hardware before enabling its translation toggle.
3. Decide whether an explicit opt-in audio-retention mode is acceptable for a stronger offline, overlap-aware speaker correction pass.
4. Decide whether to port the proven live subsystem into a Vibe fork or continue this shell.
5. Add an overt tray experience, meeting detection, retention controls, and a bundled/signed runtime.
6. Only then introduce a local meeting copilot with explicit privacy, consent, and output-quality safeguards.
