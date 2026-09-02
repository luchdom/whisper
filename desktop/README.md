# Meeting Transcriber desktop

This Electron client captures meeting audio and/or the microphone only after the user presses **Start transcription**, streams separate 16 kHz PCM tracks to the Python sidecar, and shows provisional and finalized transcript segments as they arrive.

Capture is intentionally overt. A native tray can hide the window, but it always retains a symbolic recording indicator, elapsed-time status, and Stop action while capture is active. Assistance is a separate explicit action; there is no hidden recording, automatic person naming, or audio archive.

Current source release: **v0.10.1**.

## Requirements

- Node.js 22+
- pnpm 10+
- official CPython 3.12.x (Python 3.13 and newer are not currently supported)
- A working output device for system-audio loopback
- Internet access the first time a selected faster-whisper model or the optional 29 MB speaker model is downloaded

The desktop allows up to 20 minutes for first-use model provisioning before treating startup as stalled. Closing the window cancels an in-progress startup through the bounded sidecar shutdown path; it does not wait for the full provisioning timeout.

The source bootstrap and local-engine doctor install/check code only; neither downloads a transcription or speaker model. The selected ASR model is downloaded to the Hugging Face cache only when **Start transcription** encounters a cache miss. If anonymous speaker detection is enabled, its integrity-checked model is downloaded to the app-owned model directory. Both are reused on later starts and neither is bundled in current package output.

Selecting a model persists the choice; it does not load or download the model immediately. The next start shows a phase-based native progress bar while the sidecar checks the cache, downloads an uncached model, opens it locally, and prepares optional speaker detection. The bar is indeterminate because the upstream faster-whisper helper does not provide one trustworthy aggregate percentage.

The desktop defaults to `small` on CPU with INT8 compute. Model and language controls are functional and persisted locally:

| UI choice | Engine value | Intended use |
| --- | --- | --- |
| Base — Multilingual | `base` | Lowest supported memory/cost, multiple languages |
| Base — English only | `base.en` | Lowest supported memory/cost, English meetings |
| Small — Multilingual | `small` | Balanced default, multiple languages |
| Small — English only | `small.en` | Balanced English meeting profile |
| Medium — Multilingual | `medium` | Heavier quality profile |
| Medium — English only | `medium.en` | Heavier English quality profile |

Selecting an English-only model forces the language setting to English. For multilingual models, choose Auto-detect, English, or Portuguese. Settings are locked while a meeting is active; changes apply to the next start.

## Window, tray, and startup behavior

Meeting Transcriber creates one native notification-area icon on Windows and one menu-bar icon on macOS. The icon and its text distinguish **Ready to start**, **Preparing local model — not recording**, **Recording** with elapsed time, **Needs attention**, and **Stopped — recording stopped**. During capture, **Stop transcription** remains in the native menu until the renderer confirms that capture has stopped.

**Start transcription…** in the native menu only shows the window and focuses its visible Start control; it never begins capture. Tray activation shows the window. **Quit Meeting Transcriber** always runs the same bounded capture, finalization, sidecar-shutdown, and window-release lifecycle as a normal quit.

Open **Settings > App behavior** to change the defaults:

- Closing quits the app by default. Opt in to keeping it in the Windows notification area or macOS menu bar.
- Minimizing uses normal operating-system behavior by default. Minimize-to-tray is separate and opt in.
- Launch at sign-in is off by default and is available only in an installed Windows or macOS build. It uses the operating system's login-item API, opens the first window hidden, and never starts transcription.

Only one app instance runs. A second launch shows and focuses the existing window. The explicit `--hidden` argument hides the first window for startup integration without changing capture state.

## Meeting workspace and companion overlay

The overt v0.7.0 workspace uses three regions on wide windows: a left setup rail for sources, model/language, meeting profile, and private-context selection; a center live transcript; and a right insight rail with Copilot and Debrief tabs. Between 881 and 1,119 CSS pixels the setup rail moves above the transcript and can collapse while the transcript and insight rail remain side by side. At 880 pixels and below, all regions stack into one column. The tab list supports pointer use plus Arrow Left/Right, Home, and End keyboard navigation.

### Recording permission versus OpenAI consent

Every press of **Start transcription** opens a focused confirmation dialog before capture begins. It states that transcription runs locally, audio is not saved, and the user must confirm that everyone knows and recording permission has been obtained. Cancel returns focus without changing capture state. This per-start confirmation is independent of Copilot: it neither accepts the OpenAI disclosure nor sends profile, private-context, transcript, or question data.

OpenAI setup remains local until a request. Provider/model selection, profile selection, pack management, key import, Copilot expansion, and **Review context** send nothing. Each provider transmission still requires the exact current meeting disclosure to be accepted and the user to choose **Send** explicitly. The normal Send preflight freezes and consumes a fresh main-owned one-use context pack; manual Review is optional and inspect-only.

### Overlay behavior and modes

The companion overlay is a separate compact, non-transparent window. It initializes hidden, and preparation, transcription, errors, and stopping update its state without revealing, focusing, or activating it. It appears only after an explicit **Show overlay** action in the workspace or Settings, the global Show/Hide shortcut, or an explicit overlay reset. If already visible, it stays visible and updates in place without stealing focus. Its status is one of **Ready — not recording**, **Preparing — not recording**, **Recording and transcribing**, **Needs attention**, or **Stopped — not recording**, with current source and elapsed time where applicable. Stopping the meeting or starting its replacement clears projected transcript and Copilot output without affecting the full transcript store.

Projection into the overlay is intentionally narrow: at most the two newest finalized transcript segments, each capped at 2,000 characters, and the latest explicitly requested suggestion, capped at 4,000 characters. Draft text, private-pack bodies, the API key, the provider question, raw audio, and provider-request controls do not enter its status DTO. Its only actions are **Show workspace**, **Open Copilot**, and **Hide**; it cannot start audio capture or send an OpenAI request.

The default **Accessible** mode is fully opaque, focusable, and overt. **Private** mode asks supported Windows/macOS APIs for content protection and permits **60–100%** opacity, but it is only a privacy aid: the overlay may still appear with some applications, operating-system versions, or capture methods, and it is not stealth or guaranteed invisibility. The app persists only settings version, mode, opacity, validated bounds, and display identity in `overlay-settings.json` under Electron `userData`. Transcript/provider content, visibility, click-through state, and shortcut state are not persisted. A malformed settings file fails closed to the accessible opaque default.

Click-through can be enabled only in Private mode and only while the Show/Hide recovery shortcut is successfully registered. It is disabled if the recovery shortcut becomes unavailable, when Accessible mode is restored, on reset, and across app restart. While click-through is active the overlay is not focusable; recovery remains available through the registered Show/Hide shortcut.

### Global shortcuts

| Action | Shortcut |
| --- | --- |
| Show or hide overlay | **Ctrl/Cmd+Shift+Space** |
| Focus Copilot in the full workspace | **Ctrl/Cmd+Shift+A** |
| Cancel the current Copilot request | **Ctrl/Cmd+Shift+Esc** |
| Increase private-mode opacity by 5% | **Ctrl/Cmd+Alt+Up** |
| Decrease private-mode opacity by 5% | **Ctrl/Cmd+Alt+Down** |
| Toggle private-mode click-through | **Ctrl/Cmd+Shift+X** |

Each accelerator registers independently and reports registered, unavailable, blocked, or unregistered state with a sanitized reason. A conflict does not disable unrelated actions. **Retry shortcuts** retries unavailable registrations, restoring the Show/Hide recovery path before click-through. **Reset shortcuts** unregisters only accelerators owned by Meeting Transcriber and restores the defaults. The in-window actions remain available when a global shortcut is reserved by the operating system.

The overlay window uses `contextIsolation`, sandboxing, disabled Node integration/devtools, a strict content-security policy, blocked navigation/new-window creation, and a dedicated minimal preload that exposes only status subscription plus Show workspace, Open Copilot, and Hide. Main accepts overlay IPC only from the exact local main frame, validates argument counts and bounded DTOs, and sanitizes errors. Move/resize state is clamped to the current display work area; display add/remove/metrics changes recover an off-screen overlay to an available display. Reset restores the accessible, opaque, focusable, non-click-through default at a safe location. Overlay or shortcut initialization failure cannot block local transcription.

## Hosted AI assistance

**Settings > AI assistance** configures the optional hosted meeting-assistance flow. **Off** is the default. **OpenAI API** is available, and **Local model — coming later** is visible but disabled. Selecting OpenAI or its fixed **GPT-5.6 Luna** model only persists the choice; it does not test the connection, contact OpenAI, or send meeting content. Choosing a meeting profile, editing or selecting private context, and importing a key are also local-only setup actions.

The API key never enters a renderer form or renderer state. **Import from clipboard** invokes an argument-free main-process handler, which reads the clipboard itself, trims surrounding whitespace for validation, encrypts the key with Electron's `safeStorage` API, writes ciphertext atomically to the app user-data directory, and clears the clipboard only if its original exact contents are unchanged. Windows uses DPAPI and macOS uses Keychain. **Remove key** asks for confirmation, removes the encrypted record, resets per-session consent state, and turns the provider Off. Settings exposes only privacy-safe absent/configured/invalid/unreadable state, encryption availability, and sanitized errors; no key, ciphertext, local path, or raw exception crosses preload.

If an encrypted credential artifact is malformed or cannot be read, Settings reports only that it needs removal and keeps **Remove key** available. Revocation unlinks the exact app-owned artifact without first parsing or decrypting it whenever the operating system permits deletion.

Credential status is checked lazily only when Settings opens. Import and selection do not make a connection test. The main process owns a non-persistent Electron session, fixed Responses endpoint, strict model allowlist, versioned disclosure, request bounds, cancellation, redirect rejection, and sanitized failures. With the provider Off, the controller exits before credential decryption, transcript-context serialization, DNS, or fetch. Provider setup failure cannot prevent local transcription from starting or stopping.

### Meeting profiles and private context

The meeting setup offers six immutable, versioned built-in profiles: **General**, **Sales**, **Interview**, **Presentation**, **Leadership / negotiation**, and **Custom**. They are app-owned response preferences with fixed limitations and compatible context categories; **Custom** is still a built-in profile rather than a user-editable system prompt. Profile quick actions only prefill and focus the explicit question field. They never accept consent or submit a request automatically.

Use **Manage…** under **Private context** to create local plain-text or Markdown-formatted packs in the objective, talking-points, job-description, resume, product-facts, presentation-notes, or custom-notes categories. The complete versioned store is encrypted through Electron `safeStorage` and written atomically as ciphertext under the app user-data directory; Windows uses DPAPI and macOS uses Keychain. If OS secure storage is unavailable, the app exposes no saved packs and pack creation or loading fails closed. An unreadable or invalid store is left untouched and disables pack changes without blocking the built-in profiles or local transcription.

The current limits are 24 stored packs, 12 selected compatible packs per meeting, 120 characters/240 UTF-8 bytes per name, 32,000 characters/65,536 UTF-8 bytes per body, and 262,144 UTF-8 bytes across all stored names and bodies. Create starts at revision 1; update and delete require the exact current revision. Immediately before local transcription starts, main resolves the selected profile version and pack ID/revision pairs, rejects stale or missing selections, and freezes the resolved profile and pack bodies for that meeting. Profile selection and pack management are locked while the meeting is active.

The renderer holds pack bodies only in its narrow local management library and form. They never enter ongoing Assist status or Review-context summaries; those DTOs contain only the profile's public identity and each selected pack's category, name, and byte count. Selection, editing, and key import send nothing to OpenAI.

### Using Copilot

Copilot sits in the right insight rail beside the live transcript on wide layouts and follows the responsive stack on narrow layouts. Opening, reviewing, or dismissing it sends nothing. It becomes send-eligible only while a meeting session is active, at least one finalized segment is available, OpenAI is selected, an encrypted credential is configured, the question is non-empty, the exact current disclosure has been accepted for that meeting, and the main-owned provider-context preview is not blocked.

**Review context** optionally shows a read-only transcript snapshot in the exact text/timestamp/label shape used for provider input, plus a content-free profile/pack summary and request-size preview; **Return to question** closes that inspection view without selecting or caching it. Every explicit Send preflight asks main to freeze a fresh one-use exact request pack, then consumes that same object without silently resnapshotting. Main caps its transcript portion at the most recent 48 finalized segments, 15 minutes, and 12,000 original-transcript characters. The request-size preview reports the profile, selected pack names/categories and component byte counts without including private bodies in renderer status. If the complete serialized provider context exceeds 65,536 UTF-8 bytes, preview and Send fail closed before any provider request.

For the consent-gated Send only, the provider input projects the shown built-in profile's name, version, response style, limitations, and app guidance; each meeting-start-selected pack's category, name, and body; and finalized transcript text, timestamps, and anonymous speaker/source labels. The only user-authored request field is the explicit question, including when it began as a profile quick-action prefill. Raw audio, provisional text, local translations, unselected packs, local pack IDs/revisions, internal segment IDs/revisions, language/track metadata, manual renderer-only speaker aliases, and prior assistance conversation are excluded. The API key remains outside the renderer and context pack; main decrypts it only for an approved request and uses it as the HTTPS Authorization credential to OpenAI.

Only one assistance request can run at a time. There is no queue or automatic retry. Each request has a 20-second hard timeout, a 512-token provider output cap, a 12,000-character local output cap, a five-second minimum request interval, and a six-request meeting cap. **Cancel** aborts assistance without stopping local transcription. Starting another meeting, stopping the active meeting, changing provider mode, revoking consent, or removing the key also cancels provider work and clears the meeting-scoped context or consent as appropriate.

The result is kept separate from `TranscriptStore`; it never inserts, replaces, or exports transcript text. Request/session/context-revision/sequence checks drop late, superseded, out-of-order, or cross-meeting events. The renderer does not treat the IPC request reply as proof that the separately streamed events have arrived: it waits up to two seconds for the strictly accepted terminal event. If that local delivery-integrity check times out, retry stays blocked for the same context revision so a very late old request cannot attach to a new question; the next finalized segment or a new meeting safely clears the block. A new final after the pack is frozen does not mutate or invalidate that request; the UI identifies the answer as using an earlier context revision. Another question obtains a fresh pack, and meeting start/end clears any unused one. The current OpenAI adapter renders streamed text only as **Suggested response**. It does not synthesize typed transcript-fact sections or source citations from plain provider text.

When the operating system accepts it, the global **Ctrl/Cmd+Shift+A** shortcut only reveals the window and focuses the Assist entry point. It never starts capture or submits a request; the in-window control remains available if the shortcut is reserved by the operating system. Within the question field, **Ctrl/Cmd+Enter** submits only when every normal Send condition is already satisfied; editable controls and dialogs retain their normal keyboard behavior elsewhere.

API usage may be billed separately, so Settings and the consent card open only fixed current Privacy, Data controls, and Usage pages and do not hardcode a price. This workspace has not performed a live OpenAI request, and the Assist runtime remains unverified on macOS hardware.

## Local post-meeting debrief

After the meeting stops, the **Debrief** tab enables **Generate local debrief**. The user must choose it explicitly; generation is never automatic. Its six fixed sections are **Summary**, **Decisions**, **Action items**, **Open questions and risks**, **Important objections and questions**, and **Coaching observations**. The extractor uses finalized original transcript text only. Portuguese translations remain intact in `TranscriptStore` and bilingual transcript exports, but they do not enter generated debrief claims or generated source evidence.

This path does not use a language model, provider, network request, OpenAI consent or credential, meeting profile, or private context pack. It cannot send email, post messages, create tasks, or perform another external action. Hosted Copilot and the local debrief are separate features even though they share the insight rail.

Main owns a dedicated `DebriefContextBuffer`. It starts only after the backend has started successfully, accepts finalized segments and newer revisions for that exact session, and retains the stopped context after either a complete or incomplete stop. A successful new meeting clears the previous meeting and starts a new buffer. **Delete debrief source data…** explicitly clears the current retained buffer and renderer draft, after which regeneration is unavailable. The buffer and renderer draft are memory-only and disappear when the app exits; an explicit export creates a separate user-owned Markdown file.

The renderer owns the ephemeral editable `DebriefStore`. It preserves local or manual provenance, exact source timestamps, and current speaker aliases. Generated items can be edited or removed; this release exposes no Add-item control. Action-item owner and due values are shown as **Stated**, **Proposed**, or **Not stated**; `Not stated` maps to the internal `unknown` value, and the UI never upgrades a proposal into a confirmed assignment. The bounded store recognizes **empty**, **manual**, **generating**, **ready**, **partial**, and **failed** states. An interrupted meeting, omitted context window, or extractor/source limit remains visible as partial.

Choose **Copy Markdown** or **Export Markdown…** to keep a result. Copy and save reject content larger than 2 MB. The native save dialog defaults to the configured transcript directory when one exists, but does not auto-save a debrief. Generating again while a draft exists requires confirmation before its edits or removed items are replaced. **Clear transcript view…** hides or restores transcript presentation without deleting debrief evidence; **Clear Copilot response…** affects only the current Copilot result; **Clear debrief…** removes only the renderer draft and permits generation again from the retained source; and **Delete debrief source data…** clears the retained source plus draft and disables regeneration. Existing saved Markdown files remain user-owned and are never silently deleted.

The bounds are intentionally explicit:

- Main retains at most 4,000 finalized segments and 1,000,000 original transcript characters.
- The extractor examines at most 20,000 statements, returns at most 12 generated items per section, and attaches at most 32 sources to one item.
- The renderer editor accepts at most 50 items per section and 4,000 characters per item.
- Copy and save accept at most 2,000,000 UTF-8 bytes of Markdown.

## Source setup

Install Node.js 22+, pnpm 10+, and official CPython 3.12.x first. [Python 3.12.10](https://www.python.org/downloads/release/python-31210/) is the last 3.12 release with official Windows and macOS binary installers. The project scripts never download Python, use an OS package manager, request elevation, or install into the system interpreter.

From the repository root on Windows PowerShell:

```powershell
.\scripts\bootstrap.ps1 -Start
```

On macOS:

```bash
bash ./scripts/bootstrap.sh --start
```

Omit `-Start` or `--start` to prepare and validate the checkout without launching. The scripts resolve the repository from their own location, create or reuse `backend/.venv`, install the direct Python versions pinned by `backend/constraints.txt` plus the editable backend, run Python health checks, install the exact pnpm lockfile with `--frozen-lockfile`, and run `pnpm run check`. They are safe to rerun and do not silently replace an incompatible virtual environment.

The app checks `MEETING_TRANSCRIBER_PYTHON` first, then repository/backend virtual environments, then the platform Python command. For example:

```powershell
$env:MEETING_TRANSCRIBER_PYTHON = "C:\Python312\python.exe"
pnpm start
```

This override is for development and must point to a compatible environment; it does not cause the app to install packages into that interpreter.

### In-app local engine check

Open **Settings > Local engine** to run the side-effect-free doctor. **Checking local engine…** only inspects Python and required components; it does not load or download a transcription model. The card reports ready, missing Python, unsupported Python, missing components, or components that need repair.

- **Open Python download page** asks the main process to open a fixed official `python.org` URL. It does not install Python, run a package manager, or elevate. Open a new terminal and restart the app after installation if the current process still cannot see the updated `PATH`.
- **Copy setup command** is available only when running from a source checkout whose engine components are missing or broken. Run it in a terminal from the repository root.
- **Check again** reruns the doctor after setup or repair. The non-ready main action **Open setup** takes you to this card.

This source setup remains available for contributors. `pnpm run pack` and `pnpm run dist` now create a platform-specific PyInstaller `onedir` runtime, include it as an Electron resource, and generate a CycloneDX SBOM. Installed builds verify and launch only that bundled sidecar; they do not use a system Python or show source-bootstrap remediation. Models remain on-demand and integrity-verified instead of being bundled.

Those ordinary packaging commands produce unsigned developer artifacts. `pnpm run dist:signed` requires platform signing credentials and fails closed without them; macOS additionally requires notarization credentials. Clean-machine install, same-version repair/reinstall, upgrade, uninstall, Gatekeeper/SmartScreen, and actual macOS hardware behavior remain explicit release gates documented in `docs/DISTRIBUTION.md`.

## Deterministic UI mode

The included fake sidecar speaks the production JSONL protocol and emits fixed synthetic English text, including stable speaker IDs. It is useful for UI and accessibility checks without loading a model.

```powershell
$env:MEETING_TRANSCRIBER_FAKE = "1"
pnpm start
```

```bash
MEETING_TRANSCRIBER_FAKE=1 pnpm start
```

Combine the development-only fake sidecar and fake Assist provider to test consent, context inspection, streaming suggestion, cancellation, stale-state handling, and renderer isolation without a local model or OpenAI request:

```powershell
$env:MEETING_TRANSCRIBER_FAKE = "1"
$env:MEETING_TRANSCRIBER_FAKE_ASSIST = "1"
pnpm start
```

```bash
MEETING_TRANSCRIBER_FAKE=1 MEETING_TRANSCRIBER_FAKE_ASSIST=1 pnpm start
```

These flags are ignored in a packaged app. The fake provider reports configured, still requires the meeting-scoped consent checkbox, and emits only the suggestion channel. After the first bounded audio packet, the fake sidecar emits a finalized segment while the session remains active. Manual Review is optional; Send freezes the one-use pack automatically.

## Speaker labels and renaming

When **Detect anonymous speakers** is enabled, the Python sidecar creates meeting-scoped speaker clusters for silence-delimited utterances on the meeting-audio track. The renderer numbers them by first appearance as **Speaker 1**, **Speaker 2**, and so on.

Select a speaker label in the transcript to rename it. Enter commits, Escape cancels, and a non-empty value commits on blur. The limit is 64 characters. The alias updates all current and future segments associated with that cluster and is included in copy/save output. Aliases and speaker clusters reset when a new meeting starts; they are not voice enrollment and are not persisted as an identity database.

The first version is provisional turn-level clustering. It can merge similar voices, split one voice into multiple labels, and cannot reliably separate overlap or a no-pause handoff. If the speaker model cannot load, one warning is shown and transcription continues with the truthful **Meeting audio** source label.

## Transcript saving

Local English-to-Brazilian-Portuguese translation is opt in and currently available on Windows x64. The original finalized phrase appears as soon as ASR and speaker assignment finish. Translation then runs on a separate bounded worker and enriches that exact transcript row when ready; it does not create a second final, alter the canonical English, or advance Copilot/debrief context. Translation failure or backlog cannot stop original transcription. Stop waits for accepted translation updates before automatic saving, so the available bilingual text is included in the file.

Open **Settings** to choose a default transcript folder. The native directory picker and every file write are owned by Electron's main process. The sandboxed renderer can display the selected path, but cannot supply an arbitrary path or access the filesystem directly.

- Choosing a folder also enables automatic saving; the toggle can be turned off afterward without forgetting the folder.
- **Automatically save final transcripts** writes a new collision-safe Markdown file only after a successful stop.
- A failed final decode or inference-buffer overload marks the session incomplete and skips automatic saving. Completed segments remain available to **Save copy…**; a visible unfinished draft is for review only and is not exported as final text.
- Only finalized segments are saved; draft text and audio are never written.
- Renaming a speaker after automatic saving refreshes that same app-owned file atomically.
- **Save copy…** always opens the native save dialog and does not change the current automatic-save target.
- If saving fails, the transcript remains in the window so another folder or manual copy can be chosen.

## Platform permissions

### Windows

- Allow microphone access for desktop applications in **Settings > Privacy & security > Microphone**.
- System audio uses Electron/Chromium output loopback. An active output device is required; device or driver restrictions can make loopback unavailable.

### macOS

- Electron's built-in native picker is the system-audio path on macOS, so that source requires macOS 15 or newer. The microphone remains available on older supported macOS versions.
- Grant **Microphone** and **Screen & System Audio Recording** access under **System Settings > Privacy & Security**. macOS may require the app to restart after a permission change.
- Packaging includes `NSMicrophoneUsageDescription` and `NSAudioCaptureUsageDescription` usage strings.
- Code and packaging metadata are prepared for macOS, but capture, Apple Silicon performance, signing, notarization, and installer behavior have not been runtime-validated in this workspace.

The app remains usable with only one source selected. If a selected input is denied, unavailable, or interrupted, capture stops and the UI provides a recovery message rather than silently continuing with incomplete audio.

The same fail-closed rule now covers a source that never emits or later stalls, a track muted beyond the bounded grace period, a suspended audio context, operating-system suspend/resume, and a failed main renderer. Main cancels Assist/provider work, stops the backend, marks retained debrief context incomplete, clears current autosave ownership, and keeps the tray/overlay in an error state until a fresh explicit Start. Overlay-renderer failure receives one bounded reload attempt without changing meeting capture. Deterministic tests cover the coordinator and races; native sleep/wake and crash behavior remain acceptance gates.

## Privacy boundary

- Capture starts only after the visible start action and stops before backend finalization.
- `getDisplayMedia` requires a video track; the client stops that track immediately and never reads, displays, transmits, or stores video.
- Meeting audio and microphone audio remain separate in memory and on the sidecar wire protocol.
- PCM is held only in bounded streaming buffers and is not written to disk.
- Speaker embeddings are biometric-derived data. They remain in memory only, are not logged or exported, and reset at meeting end.
- Transcript/audio payloads are not written to application logs.
- Copy and save operations export finalized transcript text only.
- Hosted assistance is Off by default. Provider/profile selection, private-context management, key import, setup, and context review make no provider request; only an explicit consent-gated Send can transmit the shown built-in profile, meeting-start-selected private packs, bounded finalized transcript, and question.
- Assistance output and state remain separate from the transcript, copy, Markdown export, and automatic-save paths.
- The local debrief uses finalized original text only and does not enter the provider, credential, consent, meeting-profile, or private-context path. Its context and renderer edits are memory-only until explicit Markdown export.
- The overlay defaults to an accessible opaque mode. Private mode is an explicit non-guarantee privacy aid; it is never described as hidden from meeting software or invisible to capture.
- The overlay receives only two bounded finalized segments and the latest bounded suggestion. It receives no raw audio, draft transcript, private-pack body, API key, provider question, or provider-send capability.
- Starting a successful new meeting replaces the current in-memory transcript. A failed model or permission retry restores the prior transcript, but text worth retaining should still be saved before another meeting.

## Validation

```powershell
pnpm test
pnpm run check
pnpm run pack
pnpm run test:desktop-soak:contract
pnpm run test:safe-storage:windows
pnpm run test:overlay-capture:plan:windows
```

The safe-storage command is a real Windows Electron/DPAPI smoke using disposable synthetic canaries. The desktop-soak contract and overlay plan commands validate harness behavior only; complete release evidence requires the operator-driven native runs described in [DESKTOP-SOAK.md](../docs/DESKTOP-SOAK.md) and [OVERLAY_CAPTURE_ACCEPTANCE.md](../docs/OVERLAY_CAPTURE_ACCEPTANCE.md).

The unit and contract suites cover streaming resampling and packet timing, transcript revision reconciliation, anonymous-speaker aliases and Markdown export, backend protocol validation, settings allowlists and atomic persistence, tray state/actions/timing, Windows and macOS login-item policy, close/minimize policy, main-owned transcript files, platform gating, backend launch selection, session state transitions, immutable meeting-profile selection, encrypted context-pack revisions and limits, content-free request previews, finalized-context replacement/bounds, Assist protocol identity, provider cancellation/backpressure, consent boundaries, renderer stale-result isolation, the three-region responsive workspace, per-start permission dialog, overlay state/projection bounds, persisted-settings schema, independent shortcut registration/retry/reset, IPC/window hardening, display recovery, debrief session lifecycle and revision replacement, deterministic extraction and evidence limits, renderer edit/provenance rules, source validation, independent clear actions, and bounded copy/export.

The v0.6.0 Windows manual runtime acceptance passed in an isolated source app at 1440, 1120, 880, and 760-pixel widths with no workspace overflow. It verified the separate focused permission dialog, rendered Ready/Private/Accessible overlay states, the exact main-owned private-mode disclosure, 80% opacity with content protection and Windows taskbar exclusion, persisted settings after restart, non-persisted click-through with Show recovery, and restoration to opacity 1 with content protection/taskbar exclusion disabled in Accessible mode. Some non-recovery accelerators were reserved by the operating system and were truthfully reported as unavailable while independent shortcuts remained usable. No live OpenAI request has been run for this release, and actual macOS `safeStorage`, menu-bar, login-item, capture, content protection, always-on-top, global-shortcut, overlay, and Assist behavior remains In Review until run on hardware.

The v0.7.0 local debrief core passed 30 focused tests before integration. A synthetic 60-minute, 4,000-segment Windows benchmark extracted the bounded result in about 65 ms and reported partial when an evidence limit was reached. The Windows implementation has local validation, but this benchmark does not establish real-meeting debrief quality. A real 60-minute meeting still needs accuracy, speaker-attribution, false-positive, and exported-file privacy review. Actual macOS debrief lifecycle, editing, source navigation, copy, and export behavior also remains In Review. A live OpenAI request is neither used nor relevant to the local debrief path.
