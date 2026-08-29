# Meeting Transcriber desktop

This Electron client captures meeting audio and/or the microphone only after the user presses **Start transcription**, streams separate 16 kHz PCM tracks to the Python sidecar, and shows provisional and finalized transcript segments as they arrive.

Capture is intentionally overt. A native tray can hide the window, but it always retains a symbolic recording indicator, elapsed-time status, and Stop action while capture is active. Assistance is a separate explicit action; there is no hidden recording, automatic person naming, or audio archive.

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

### Using Assist with this meeting

The Assist section sits below the live transcript. Opening, reviewing, or dismissing it sends nothing. It becomes send-eligible only while a meeting session is active, at least one finalized segment is available, OpenAI is selected, an encrypted credential is configured, the question is non-empty, the exact current disclosure has been accepted for that meeting, and the main-owned provider-context preview is not blocked.

**Review context** optionally shows a read-only transcript snapshot in the exact text/timestamp/label shape used for provider input, plus a content-free profile/pack summary and request-size preview; **Return to question** closes that inspection view without selecting or caching it. Every explicit Send preflight asks main to freeze a fresh one-use exact request pack, then consumes that same object without silently resnapshotting. Main caps its transcript portion at the most recent 48 finalized segments, 15 minutes, and 12,000 original-transcript characters. The request-size preview reports the profile, selected pack names/categories and component byte counts without including private bodies in renderer status. If the complete serialized provider context exceeds 65,536 UTF-8 bytes, preview and Send fail closed before any provider request.

For the consent-gated Send only, the provider input projects the shown built-in profile's name, version, response style, limitations, and app guidance; each meeting-start-selected pack's category, name, and body; and finalized transcript text, timestamps, and anonymous speaker/source labels. The only user-authored request field is the explicit question, including when it began as a profile quick-action prefill. Raw audio, provisional text, local translations, unselected packs, local pack IDs/revisions, internal segment IDs/revisions, language/track metadata, manual renderer-only speaker aliases, and prior assistance conversation are excluded. The API key remains outside the renderer and context pack; main decrypts it only for an approved request and uses it as the HTTPS Authorization credential to OpenAI.

Only one assistance request can run at a time. There is no queue or automatic retry. Each request has a 20-second hard timeout, a 512-token provider output cap, a 12,000-character local output cap, a five-second minimum request interval, and a six-request meeting cap. **Cancel** aborts assistance without stopping local transcription. Starting another meeting, stopping the active meeting, changing provider mode, revoking consent, or removing the key also cancels provider work and clears the meeting-scoped context or consent as appropriate.

The result is kept separate from `TranscriptStore`; it never inserts, replaces, or exports transcript text. Request/session/context-revision/sequence checks drop late, superseded, out-of-order, or cross-meeting events. The renderer does not treat the IPC request reply as proof that the separately streamed events have arrived: it waits up to two seconds for the strictly accepted terminal event. If that local delivery-integrity check times out, retry stays blocked for the same context revision so a very late old request cannot attach to a new question; the next finalized segment or a new meeting safely clears the block. A new final after the pack is frozen does not mutate or invalidate that request; the UI identifies the answer as using an earlier context revision. Another question obtains a fresh pack, and meeting start/end clears any unused one. The current OpenAI adapter renders streamed text only as **Suggested response**. It does not synthesize typed transcript-fact sections or source citations from plain provider text.

When the operating system accepts it, the global **Ctrl/Cmd+Shift+A** shortcut only reveals the window and focuses the Assist entry point. It never starts capture or submits a request; the in-window control remains available if the shortcut is reserved by the operating system. Within the question field, **Ctrl/Cmd+Enter** submits only when every normal Send condition is already satisfied; editable controls and dialogs retain their normal keyboard behavior elsewhere.

API usage may be billed separately, so Settings and the consent card open only fixed current Privacy, Data controls, and Usage pages and do not hardcode a price. This workspace has not performed a live OpenAI request, and the Assist runtime remains unverified on macOS hardware.

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

This is still a developer setup. `pnpm run pack` and `pnpm run dist` include backend source and constraints, but not Python, native Python dependencies, the source bootstrap scripts, or Whisper models. Their output is not a standalone clean-machine installer. A standalone release still requires a bundled and signed platform-specific runtime plus clean-machine Windows and macOS validation.

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
- Starting a successful new meeting replaces the current in-memory transcript. A failed model or permission retry restores the prior transcript, but text worth retaining should still be saved before another meeting.

## Validation

```powershell
pnpm test
pnpm run check
pnpm run pack
```

The unit suite covers streaming resampling and packet timing, transcript revision reconciliation, anonymous-speaker aliases and Markdown export, backend protocol validation, settings allowlists and atomic persistence, tray state/actions/timing, Windows and macOS login-item policy, close/minimize policy, main-owned transcript files, platform gating, backend launch selection, session state transitions, immutable meeting-profile selection, encrypted context-pack revisions and limits, content-free request previews, finalized-context replacement/bounds, Assist protocol identity, provider cancellation/backpressure, consent boundaries, and renderer stale-result isolation. Windows source runtime behavior can be exercised locally; no live OpenAI request has been run for this release, and macOS `safeStorage`, menu-bar, login-item, capture, and Assist behavior remains unverified until run on actual macOS hardware.
