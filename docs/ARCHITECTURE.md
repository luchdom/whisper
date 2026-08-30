# Architecture and delivery boundary

Current source release: **v0.7.0**.

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
                                                                                └─> one atomic final event
                                                                                      ├─> transcript UI/export
                                                                                      ├─> overlay projection: newest two finals only
                                                                                      ├─> main-owned local debrief buffer
                                                                                      │    └─> explicit stopped/incomplete local extract
                                                                                      │         └─> ephemeral renderer debrief store
                                                                                      │              └─> explicit copy/Markdown export
                                                                                      └─> main-owned Assist context buffer
                                                                                           + meeting-start-frozen profile/private packs
                                                                                           └─> one-use bounded provider snapshot + question
                                                                                                └─> optional OpenAI Responses stream
                                                                                                     ├─> separate Copilot result UI
                                                                                                     └─> overlay: latest suggestion only
```

The two audio sources stay separate from capture through inference. That gives a truthful `You` versus `Meeting audio` distinction, preserves source overlap, and avoids destroying source information by mixing. Optional local speaker clustering adds provisional anonymous IDs only to silence-delimited system-audio utterances.

## Responsibilities

### Desktop main process

- Owns the Electron workspace and compact overlay windows, single-instance lock, native tray, OS login-item integration, OS media permissions, system-loopback selection, settings persistence, safe local export, and sidecar lifecycle.
- Validates every renderer command and every sidecar event at the IPC boundary.
- Loads the bundled model manifest and exposes only a sanitized catalog data-transfer object (DTO) containing public IDs and presentation metadata. Repository revisions, URLs, hashes, and local cache paths do not cross into the renderer.
- Relays only allowlisted model-preparation phases; app-owned cache paths and download internals never cross into the renderer.
- Owns native file/folder pickers and every file write. The sandboxed renderer may display the selected transcript-directory path, but it cannot submit an arbitrary path or perform filesystem operations.
- Owns the optional hosted-provider boundary: immutable built-in profile catalog, operating-system-encrypted private context store, exact profile/pack-revision freeze at meeting start, canonical finalized-segment context buffer, content-free size preview, frozen bounded request snapshot, meeting-scoped versioned consent, non-persistent network session, fixed endpoint/model/system policy, operating-system-encrypted credential store, request bounds, cancellation, identity sequencing, and sanitized errors. Provider initialization and request failure are isolated so neither can block local transcription.
- Owns the separate bounded `DebriefContextBuffer`, starts it only after backend start succeeds, ingests finalized original segments and newer revisions, retains complete or incomplete stopped context, runs the deterministic local extractor only after explicit generation, and owns bounded clipboard/native Markdown export plus explicit source-data deletion. This path has no provider, credential, consent, profile, or private-pack authority.
- Owns overlay policy, bounded finalized-segment/suggestion projection, versioned overlay-settings persistence, independent global-shortcut registration, transient click-through recovery, display clamping/recovery, and exact-window IPC authorization. Overlay or shortcut failure remains optional and cannot block the local capture/sidecar path.
- Does not log stderr, PCM, transcript text, or participant data.

### Sandboxed renderer

- Requests capture only after the visible start action and an explicit per-start recording-permission confirmation.
- Stops Chromium's required display video track immediately; video frames are never read or stored.
- Uses an `AudioWorklet` and deterministic streaming resampler to produce signed 16-bit little-endian, mono, 16 kHz packets.
- Builds the model picker from the sanitized catalog instead of maintaining a second model allowlist.
- Reconciles stable segment IDs by increasing revision, assigns first-seen friendly labels, applies session-local manual aliases, preserves original text as canonical, and exports finalized text only.
- Presents model preparation as accessible indeterminate progress and clears it when the engine becomes ready or unavailable.
- Reports only an exact tray-state enum and accepts only fixed focus/stop tray actions; transcript text, errors, paths, and participant data never enter native tray content.
- Can choose Off or the allowlisted OpenAI provider, request lazy configured/encryption-available status, and trigger argument-free clipboard import/revocation. It never receives an API key, ciphertext, credential path, arbitrary provider URL, or raw provider exception.
- Chooses one immutable built-in meeting profile and up to 12 compatible exact context-pack revisions before Start. Local pack management can display and edit pack bodies, but ongoing Assist status, request-preview, and Review-context DTOs contain only content-free profile and pack metadata.
- Presents the wide three-region workspace with setup on the left, live transcript in the center, and Copilot/Debrief tabs on the right, then progressively collapses and stacks those regions at narrower widths.
- Presents Copilot in the insight rail, optionally reviews the main-owned finalized transcript plus content-free meeting-context summary, submits only an explicit question after current-version meeting consent, and renders provider events in state that is separate from `TranscriptStore`. Profile quick actions only prefill this question and never auto-send.
- Owns the ephemeral editable `DebriefStore`, validates exact transcript sources, resolves source timestamps with current speaker aliases, keeps generated/manual provenance and action-field certainty, renders honest document states, and serializes the reviewed local draft to Markdown for main-owned copy/export. The current UI exposes edit/remove for generated items, not an Add-item control.
- Uses session, request, context-revision, and event-sequence checks to reject late, superseded, out-of-order, or cross-meeting assistance output. Session transitions and every accepted final invalidate older status/consent reads; main captures the context after its awaited credential-status read, and the renderer applies only the exact current status generation. Because Electron invoke replies and streamed renderer events use separate channels, a renderer-owned attempt latches only a strictly accepted terminal event and waits for that event after the invoke reply. A local terminal-delivery timeout blocks another request against the same context revision until a new final or meeting replaces that identity. A newer transcript revision marks an accepted result as based on an earlier frozen context rather than silently changing its provenance.

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

## Overt workspace and companion boundary

The v0.7.0 renderer is an overt meeting workspace rather than a concealed assistant. Its wide layout has three regions: a setup rail for capture/model/profile/private-context controls, a canonical live-transcript region, and an insight rail with Copilot and Debrief tabs. At medium widths the setup rail moves above the other two and can collapse; at narrow widths all three regions stack. Responsive layout changes presentation only and do not change ownership of capture, transcript, context, debrief, or provider state.

Recording and hosted assistance use separate gates. Every local Start opens a renderer-owned modal that states audio stays local/not saved and requires the user to confirm participant knowledge and recording permission before capture APIs are called. Each OpenAI transmission separately requires the current meeting disclosure plus an explicit Send. Accepting either gate does not accept the other; neither profile/private-context setup nor provider consent starts audio capture.

The compact overlay is created by main as a separate window and starts hidden. Backend preparation can set **Preparing — not recording**, but only renderer-confirmed transcription may auto-reveal it, without focus. The complete state vocabulary is **Ready — not recording**, **Preparing — not recording**, **Recording and transcribing**, **Needs attention**, and **Stopped — not recording**. Show/Hide never changes capture state, and meeting stop or replacement clears the projected meeting content.

Overlay projection is finalized-only and bounded independently from the canonical stores: no more than two segments, each no more than 2,000 characters, plus the latest explicitly requested suggestion up to 4,000 characters. It receives no draft transcript, raw audio, provider question, private-pack body, API key, or provider-send capability. The overlay preload exposes only status read/subscription, Show workspace, Open Copilot, and Hide; every start, consent, Review, and Send action remains in the full workspace.

The version-1 overlay settings schema defaults to **Accessible** mode, opacity 1, and a safe 560 × 360 DIP location with a 420 × 300 DIP minimum. Accessible mode is always fully opaque. **Private** mode permits only **60–100%** opacity and requests platform content protection, but its disclosure explicitly says this is a privacy aid rather than stealth or guaranteed invisibility. Only schema version, mode, opacity, validated bounds, and display identity are persisted in `overlay-settings.json`; transcript/provider content, visibility, click-through, and shortcut state are not. Invalid persisted state falls back to the accessible opaque default.

Click-through is transient and valid only in Private mode while the Show/Hide recovery shortcut is registered. Main makes the window non-focusable while it is active and disables it if the recovery shortcut is lost, Show recovers the window, Accessible mode is restored, settings are reset, or the app restarts.

Global accelerators are fixed and independently available:

| Main-owned action | Accelerator |
| --- | --- |
| Show/hide overlay | `CommandOrControl+Shift+Space` |
| Focus Copilot in workspace | `CommandOrControl+Shift+A` |
| Cancel current Copilot request | `CommandOrControl+Shift+Esc` |
| Increase private opacity by 5% | `CommandOrControl+Alt+Up` |
| Decrease private opacity by 5% | `CommandOrControl+Alt+Down` |
| Toggle private click-through | `CommandOrControl+Shift+X` |

Each registration has its own registered/unavailable/blocked/unregistered status and sanitized reason. A conflict cannot disable unrelated shortcuts. Retry attempts unavailable registrations and recovers Show/Hide before click-through; Reset unregisters only app-owned accelerators and restores defaults. Generation checks prevent callbacks from stale registrations from changing current state.

The overlay `BrowserWindow` is non-transparent and uses context isolation, sandboxing, disabled Node integration/devtools, web security, a restrictive content-security policy, denied new windows, and navigation locked to its exact local document. Dedicated preload and main IPC surfaces validate the exact main frame, argument count, and bounded DTO shape. Move/resize persistence is debounced; display add/remove/metrics changes are also debounced and clamp the overlay into an available work area. Missing displays and Reset recover it to the primary/available display in an opaque, focusable, non-click-through state.

## Local post-meeting debrief boundary

The local debrief is a separate memory path, not a hosted-assistance mode. Main calls `DebriefContextBuffer.startSession` only after `backend.startSession` returns a backend-owned session ID. The buffer accepts only finalized events for that exact session and replaces a segment only with a higher revision. It stores original text as the debrief evidence source; any pt-BR translation remains in the canonical transcript event and is excluded from generated claims and generated-source Markdown.

Normal stop finalizes the buffer as complete. Interrupted, failed, or ambiguous stop reasons finalize it as incomplete while retaining the finalized text already received. The context remains available after stop, but the extractor does not run automatically; the user must choose **Generate local debrief**. A successful later meeting clears the prior context before accepting new finals. **Delete debrief source data…** clears the retained context and renderer draft and disables regeneration. The context has no disk persistence across app exit. An explicitly exported Markdown file is outside that lifecycle, remains user-owned, and is never silently deleted.

`extractLocalDebrief` is deterministic and extractive. It makes no LLM or provider call, requires no OpenAI consent or credential, and receives no meeting profile or private context pack. It has no tool or external-action interface, so it cannot email, post, create a task, or mutate another system. Its schema has exactly six sections: **Summary**, **Decisions**, **Action items**, **Open questions and risks**, **Important objections and questions**, and **Coaching observations**. Extraction and renderer verification share the same whitespace normalization and bounded-prefix rules, so a long or multiline original remains source-verifiable without accepting an unrelated renderer claim.

The renderer's `DebriefStore` is ephemeral and separate from `TranscriptStore` and Copilot state. Its schema supports local-extractive, local-observation, and manual provenance; the current UI allows edits and removals of generated items but does not expose manual Add. Exact source timestamps and current speaker aliases are resolved at display/export time. Action owner/due fields use `stated`, `proposed`, or `unknown` internally and present them as **Stated**, **Proposed**, or **Not stated**. Its document state is one of `empty`, `manual`, `generating`, `ready`, `partial`, or `failed`. Incomplete context, retained-window truncation, statement/item/source limits, or extraction failure remains explicit rather than being presented as complete.

The clear operations are independently scoped. Hiding/restoring the transcript view does not remove the underlying transcript or debrief sources. Clearing a Copilot response does not clear the transcript or debrief. Generating while a draft exists requires confirmation before replacing edits or removed items. **Clear debrief…** removes only the renderer draft and permits a new explicit generation from retained source data. **Delete debrief source data…** removes the retained main-owned buffer and renderer draft and disables regeneration. Neither action changes the transcript, Copilot response, private packs, or existing Markdown exports.

The local debrief has four bounded layers:

- `DebriefContextBuffer`: 4,000 finalized segments and 1,000,000 original transcript characters.
- `extractLocalDebrief`: 20,000 statements, 12 generated items per section, and 32 sources per item.
- `DebriefStore`: 50 editable items per section, 4,000 characters per item, and 32 sources per item.
- Main copy/save IPC: 2,000,000 UTF-8 bytes of Markdown.

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

## Hosted assistance boundary

Hosted assistance is Off by default. Provider/model/profile selection, private-context creation, editing, selection, or deletion, credential status checks, credential import, opening Assist, context review, and dismissal do not contact OpenAI. A network request is possible only from the explicit Assist Send path after the current meeting has finalized text and the exact current disclosure is accepted.

Credential import is main-process-only and argument-free across preload. Main reads the current clipboard, trims only surrounding whitespace for key validation, encrypts the key with Electron's `safeStorage`, atomically persists a versioned ciphertext record under the exact app user-data path, and clears the clipboard only when the original exact value is still present. Windows maps this to DPAPI and macOS to Keychain. Decryption exists only for a bounded main-owned request; renderer DTOs contain only privacy-safe credential state and encryption availability, never a key, ciphertext, path, or raw exception. Revocation cancels provider work, clears consent, removes the encrypted record, and turns the runtime provider Off even if preference persistence later fails.

Credential inspection exposes only `absent`, `configured`, `invalid`, or `unreadable`. Invalid and unreadable artifacts remain explicitly removable; revocation attempts to unlink the exact app-owned path without parsing or decrypting the artifact first.

The versioned profile catalog is deeply immutable and contains six built-ins: **General**, **Sales**, **Interview**, **Presentation**, **Leadership / negotiation**, and **Custom**. Each profile fixes its public response style, limitations, compatible context categories, quick-action prompts, and internal app guidance. **Custom** is therefore a broad built-in preference, not a renderer-authored system prompt. A quick action only assigns its prompt to the explicit question field and focuses the field; it does not alter consent or invoke Send.

The private-context store accepts plain text or Markdown-formatted text in seven fixed categories: objective, talking points, job description, resume, product facts, presentation notes, and custom notes. Main encrypts the entire versioned JSON store with Electron `safeStorage`, writes the ciphertext wrapper atomically with restrictive file mode under `userData`, and fails closed when OS encryption is unavailable or the store is invalid. An unreadable store is never treated as empty or overwritten: renderer pack mutations are disabled while the immutable profile catalog and local transcription remain available. Windows maps `safeStorage` to DPAPI and macOS to Keychain. The current bounds are 24 stored items, 12 selected items, 120 characters/240 UTF-8 bytes per name, 32,000 characters/65,536 UTF-8 bytes per body, 262,144 UTF-8 bytes across all stored names and bodies, a 393,216-byte plaintext-store cap, and a 786,432-byte encrypted-wrapper cap.

Pack create begins at revision 1; update and delete require an exact positive revision and updates increment it. Before starting the sidecar, main resolves the chosen profile ID/version and each selected pack ID/revision, rejects duplicates, stale revisions, missing packs, over-limit selection, and profile-incompatible categories, then freezes the normalized profile and pack bodies in the Assist session context. The renderer locks profile and pack controls for the active meeting. Pack bodies cross preload only through the narrow local context-pack library and CRUD contracts; they never enter Assist status, request-preview, or Review-context summaries, which expose only profile identity and pack category/name/byte counts.

The OpenAI transport uses an in-memory Electron session and the exact `https://api.openai.com/v1/responses` endpoint. The renderer cannot supply an endpoint, model ID outside the allowlist, system prompt, tools, conversation ID, metadata, prior response, or an arbitrary context payload. Requests set `store: false` and `background: false`, reject redirects, stream bounded SSE, allow one in-flight request with no queue or retry, support cancellation, and enforce a 20-second timeout, 512-token provider output cap, 12,000-character local output cap, five-second minimum interval, and six-request meeting cap. Provider Off returns before credential decryption, context serialization, DNS, or fetch.

Hosted model IDs are allowlisted identifiers, not downloaded artifacts. They cannot be pinned through the local model manifest's commit and SHA-256 contract, and the provider may update behavior behind an identifier. Immutable revision and artifact-hash guarantees apply only to locally downloaded models.

The versioned disclosure is the single main-owned source of UI copy and fixed Privacy, Data controls, and Usage link IDs. Consent is exact-version and scoped to the active meeting. Review optionally shows the bounded transcript shape and a content-free summary of the meeting-start profile/packs, then returns the user to the question. Every explicit Send preflight asks main to combine that frozen session context with canonical transcript context at one revision into a fresh one-use object: no more than the newest 48 final segments, 15 minutes, or 12,000 transcript characters. The request consumes that exact main object and never silently resnapshots; another Send obtains another transcript snapshot while retaining the meeting-start profile and exact pack revisions, and meeting start/end clears any unused request object. A new final after freezing does not mutate or invalidate the request, and the renderer marks the result stale against the newer canonical transcript revision.

The local frozen snapshot retains profile and pack IDs/revisions plus segment IDs/revisions, timing, track, language, and anonymous speaker IDs for validation and stale identity. Before transport, main projects only the shown built-in profile's name, version, response style, fixed limitations, and app guidance; each selected private pack's category, name, and body; and original finalized transcript text, timestamps, and anonymous speaker/source label. The renderer contributes only the explicit question. Unselected packs, local profile/pack/segment IDs and revisions, track/language metadata, manual renderer-only aliases, audio, provisional text, local translations, hidden metadata, and prior assistance conversation do not enter the provider input body. The profile and private-pack projection occurs only on the explicit consent-gated Send path. The API key stays outside the renderer and context pack; main decrypts it only for a bounded approved request and sends it in the HTTPS `Authorization` header required to authenticate with OpenAI.

Before Send becomes eligible, main serializes that projected profile, selected packs, and transcript to build a content-free request preview. If the complete provider-context JSON exceeds 65,536 UTF-8 bytes, preview returns a sanitized blocked state and Send fails closed before credential decryption or network activity. The preview exposes total/component byte counts, profile name/version, pack category/name, and transcript count/time range, but no private pack bodies.

The assistance controller treats transcript and private-pack bodies as untrusted input, treats the built-in profile as an app-owned response preference, allows no tools or external actions, and emits a strictly sequenced request/session/context envelope. Stop, restart, cancellation, provider changes, consent or credential revocation, timeout, and supersession abort work and prevent stale output from attaching to another meeting. Provider failure never changes sidecar capture/start/stop/finalization and never mutates `TranscriptStore` or transcript exports.

The current OpenAI adapter maps provider text deltas only to the `suggestion` channel. Although the local typed protocol can represent other channels and citations for deterministic testing or a future structured provider, this release does not infer transcript facts, citations, supporting points, or uncertainty labels from raw OpenAI text.

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

- Capture is explicit and visibly indicated. Hiding the window is opt in; the native tray keeps a distinct recording symbol, elapsed timer, and stop action until capture actually stops.
- Every Start requires a fresh recording-permission confirmation. That confirmation is separate from the meeting-scoped disclosure and explicit Send required for each OpenAI projection.
- Tray **Start transcription…** only reveals and focuses the visible Start control. Login-item and `--hidden` launches never start capture.
- Audio is memory-only and is never sent to a transcription API.
- A selected model can access the network only for initial provisioning. Every later startup re-verifies the app-owned local artifact and can remain offline when verification succeeds.
- Speaker embeddings are biometric-derived data. They remain memory-only and are cleared at meeting end; only anonymous IDs and user-entered display aliases reach transcript events/files.
- Automatic saving is explicit, final-text-only, main-process-owned, collision-safe, and atomic. A post-stop speaker rename refreshes only the current app-owned autosave file.
- Translation never replaces or mutates the original transcript. The original remains available when translation is disabled, unsupported, or fails.
- A final ASR failure or inference overload produces a non-success session reason. The main process then blocks autosave so an incomplete transcript is never announced as successfully saved.
- Voice identity, voice enrollment, cloud summaries, automatic/background advice, and external actions require separate opt-in designs.
- The local debrief is explicitly generated, deterministic, extractive, original-text-only, and memory-only until explicit Markdown export. It cannot access the provider, credential, consent, meeting-profile, private-pack, or external-action paths. Draft clear and retained-source deletion are separate, and neither silently deletes the transcript, Copilot response, private packs, or a user-owned export.
- Hosted assistance remains Off by default. Provider/profile selection, private-context management, key import, setup, and Assist review send nothing. The explicit Send action requires current-version consent for the active meeting and can transmit only the shown built-in profile, exact meeting-start-selected private pack bodies, bounded finalized transcript, and the user's question. It excludes audio, drafts, local translations, unselected packs, manual speaker names, and prior assistance conversation. Main uses the separately stored API key only in the HTTPS Authorization header.
- The overlay is overt and fully opaque by default. Private mode's content-protection request and reduced opacity are a non-guarantee privacy aid, never a promise that meeting or capture software cannot see the window.
- Only two bounded finalized segments and the latest bounded suggestion cross into overlay state. Private-pack bodies, questions, credentials, audio, drafts, and provider-send APIs do not.
- Windows endpoint loopback can include notifications and unrelated application sounds. Process-scoped capture is a later privacy improvement.

## Platform boundary

Windows 11 capture, local inference, and the local debrief implementation have been exercised in this workspace. The built-in macOS system-audio path uses Electron's native picker and is gated to macOS 15 or newer; microphone-only capture remains available below that gate. Tray, login-item, overlay, shortcut, persistence, hardening, display-recovery, and debrief decisions are covered by deterministic policy/contract tests. An isolated Windows source-app runtime acceptance also passed for the responsive workspace, permission dialog, overlay mode/policy transitions, settings restart persistence, and click-through recovery; unavailable non-recovery shortcuts were isolated and reported truthfully. Actual macOS menu-bar, login-item, capture, content protection, always-on-top, global-shortcut, overlay, Assist, local-debrief lifecycle/edit/source-navigation/copy/export, Apple Silicon performance, signing, notarization, and packaging behavior remains In Review until tested on hardware.

Local translation is currently enabled only for Windows x64. The INT8 converted output was reproduced twice with identical hashes on that platform. The macOS setting stays unavailable until the conversion outputs and runtime behavior are verified on Intel and Apple Silicon as applicable; the application does not assume that Windows conversion hashes are portable.

The source repository provides repo-relative, idempotent Windows and macOS bootstrap scripts. After the user installs Node.js 22+, pnpm 10+, and official CPython 3.12.x, one command creates `backend/.venv`, installs the constrained editable backend, verifies the pinned CTranslate2 and SentencePiece imports, installs the frozen pnpm lockfile, and runs the source checks.

Distribution keeps that source boundary but adds a platform-native PyInstaller `onedir` sidecar. `scripts/build-sidecar.mjs` uses a pinned build toolchain, collects the active CPython interpreter plus the ASR/diarization/translation native stack, and verifies the resulting executable with both the content-free setup probe and the production JSONL shutdown lifecycle. Electron places the whole runtime directory under `process.resourcesPath/sidecar`; packaged main strips development runtime overrides, setup probes only the bundled executable, and the controller launches it directly without Python module arguments. Failure never falls back to a global interpreter. Backend source and the immutable model manifest remain separate resources for the model catalog; model artifacts remain on-demand.

Every distribution also includes `SBOM.cdx.json` and `THIRD_PARTY_NOTICES.md`. Unsigned developer packages remain distinct from release acceptance. The release configuration forces Windows/macOS signing and enables macOS notarization, while repository workflows build Windows x64 and macOS ARM artifacts on their native OS. Signing credentials, notarization, clean-machine install/upgrade/repair/uninstall, and hardware behavior are external gates; see `docs/DISTRIBUTION.md`.

## Validation boundary

The automated soak compresses 60 virtual minutes into a deterministic queue/state regression and reports its limitation in its output. It verifies bounded queue accounting and drainage, not real-time ASR throughput, translation throughput, meeting-capture durability, or speaker accuracy. A separate strict release-scope wall-clock backend run fed the first hour of a public multi-speaker recording through the production JSONL sidecar at the application's 200 ms packet cadence with real `small.en` inference, online diarization, and local English-to-pt-BR translation. That Windows sidecar gate now passes, but it bypasses desktop system-audio capture, Electron IPC, renderer reconciliation, and autosave. A real 60-minute Windows desktop meeting and a real 60-minute macOS meeting with working devices remain required.

A one-sentence English-to-pt-BR smoke completed in 0.109 seconds on the validated Windows machine. The strict wall-clock run then delivered all 18,000 real-time packets, emitted a non-empty pt-BR-labeled payload for all 287 non-empty final segments, skipped one empty final, emitted no warnings or errors, and stopped the decoder and sidecar cleanly with empty stderr. Resident memory peaked at 1,341.5 MiB, while private-memory medians decreased by 50.1 MiB from the first stable window to the last; final-segment latency was 5.835 seconds at p50, 7.985 seconds at p95, and 9.535 seconds maximum. The evaluator returned `passed: true`, `acceptance_scope: release`, and no acceptance failures. This completes the strict Windows backend translation-pipeline gate, but it does not independently assess Portuguese meaning. Windows desktop capture/autosave and macOS runtime gates remain outstanding, and the ten anonymous clusters produced during the source do not establish speaker-label accuracy.

Assist has deterministic protocol, immutable-profile, encrypted-pack revision/limit, content-free preview, oversize fail-closed, context-boundary, cancellation, and renderer-state coverage. With `MEETING_TRANSCRIBER_FAKE=1` and `MEETING_TRANSCRIBER_FAKE_ASSIST=1`, the development fake sidecar emits a finalized segment during the active session after the first bounded audio packet and the fake provider streams suggestion text without a provider network request. These paths are disabled in packaged builds and still require explicit start, a selected audio source, and meeting-scoped consent. Manual Review remains optional because Send preflight freezes the one-use request pack automatically. No live OpenAI API request was made for this milestone, so authentication, billing-account behavior, real network streaming, selected-profile/private-pack behavior against the hosted model, model quality, and provider-side latency remain unverified. The 20-second timeout is an enforced request bound, not a measured provider-latency guarantee. OS-encrypted private-context behavior and the broader Assist runtime also remain unverified on actual macOS hardware.

The v0.6.0 deterministic gates cover the three-region responsive workspace, per-start permission modal, overlay lifecycle and bounded finalized-only projection, accessible/private policy, 60–100% private opacity, exact persisted schema, non-persisted recovery-gated click-through, independent shortcut availability/retry/reset, hardened window/preload/IPC contracts, and multi-display recovery. The isolated Windows source-app acceptance then rendered 1440/1120/880/760-pixel layouts without overflow, verified the separately focused permission dialog, Ready/Private/Accessible overlay states, the exact main-owned disclosure, 80% private opacity with content protection and taskbar exclusion, settings persistence after restart, click-through non-persistence and Show recovery, and Accessible restoration to opacity 1 with protection/taskbar exclusion disabled. Some non-recovery accelerators were unavailable because of operating-system conflicts and remained isolated from other shortcut actions. Actual macOS content protection, always-on-top, global shortcuts, display behavior, and opacity/click-through behavior remain In Review.

The v0.7.0 local-debrief core passed 30 focused tests before desktop integration. A synthetic 60-minute input containing 4,000 finalized segments extracted in about 65 ms on the validated Windows machine and produced an explicit partial state when an evidence bound was reached. This validates bounded deterministic extraction and limit reporting, not real-meeting accuracy. A real 60-minute meeting must still evaluate summary/decision/action accuracy, anonymous-speaker and renamed-alias attribution, false positives, source navigation, edits, and exported-file privacy. Actual macOS behavior remains In Review. Live OpenAI is outside this local path and was not used.

## Staged roadmap

1. Run a real 60-minute Windows desktop meeting with English-to-pt-BR translation enabled through system-audio capture, Electron IPC, renderer reconciliation, and autosave; measure end-to-end latency, dropped-audio behavior, anonymous-label stability, and local-debrief accuracy, attribution, false positives, source navigation, edits, and exported-file privacy.
2. Validate macOS system audio, microphone capture, speaker clustering, ASR performance, `safeStorage` credential/private-context behavior, Assist, local-debrief lifecycle/edit/source-navigation/copy/export, overlay content protection/always-on-top/global shortcuts/display recovery, and deterministic local translation conversion/runtime behavior on actual macOS hardware before enabling its translation toggle.
3. Decide whether an explicit opt-in audio-retention mode is acceptable for a stronger offline, overlap-aware speaker correction pass.
4. Decide whether to port the proven live subsystem into a Vibe fork or continue this shell.
5. Validate the overt tray experience on macOS hardware, then add meeting detection, retention controls, and a bundled/signed runtime.
6. Run an explicitly authorized live OpenAI Assist check with a disposable meeting, profile, private pack, and credential, then verify the provider projection and measure first-token latency, cancellation, stale-result behavior, rate/error handling, and cost without capturing sensitive meeting content.
7. Design a structured provider-output contract before presenting transcript facts, local timestamp citations, or uncertainty as authoritative UI sections; the current OpenAI path intentionally exposes only raw suggested text.
8. Evaluate a fully local assistance model after measuring its disk, RAM, latency, and quality tradeoffs on Windows and macOS.
