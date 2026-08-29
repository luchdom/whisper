# Meeting Transcriber desktop

This Electron client captures meeting audio and/or the microphone only after the user presses **Start transcription**, streams separate 16 kHz PCM tracks to the Python sidecar, and shows provisional and finalized transcript segments as they arrive.

Capture is intentionally overt. There is no tray mode, hidden recording, meeting copilot, automatic person naming, or audio archive.

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
- Starting a successful new meeting replaces the current in-memory transcript. A failed model or permission retry restores the prior transcript, but text worth retaining should still be saved before another meeting.

## Validation

```powershell
pnpm test
pnpm run check
pnpm run pack
```

The unit suite covers streaming resampling and packet timing, transcript revision reconciliation, anonymous-speaker aliases and Markdown export, backend protocol validation, settings allowlists and atomic persistence, main-owned transcript files, platform gating, backend launch selection, and session state transitions.
