<p align="center">
  <img src="desktop/build/icon.png" width="128" height="128" alt="Meeting Transcriber logo">
</p>

# Meeting Transcriber

A local-first Windows and macOS desktop prototype for transcribing meetings while they happen. It captures meeting audio and the microphone as separate tracks, streams them to a local Python process, and replaces provisional text with finalized segments in the UI.

Current source release: **v0.10.0**.

## What works

- Live microphone and meeting-audio capture on the validated Windows 11 machine.
- Local `faster-whisper` transcription with 14 curated multilingual, English-only, and distilled model choices.
- A visible first-use loading bar with separate cache-check, download, verification, local-initialization, speaker-model, and translation-model phases.
- Auto-detect, English, and Portuguese language modes. Selecting an `.en` model fixes the language to English.
- Provisional anonymous labels for the meeting-audio track: **Speaker 1**, **Speaker 2**, and so on.
- In-place speaker renaming. A rename applies to every segment from that speaker for the current meeting and to the exported transcript.
- Local settings for speaker detection, transcript folder, and automatic saving after a successful stop.
- An explicit, consent-gated **Assist with this meeting** flow with OpenAI Off by default, a fixed hosted-model allowlist, operating-system encrypted API-key storage, app-owned meeting profiles, selected private context, bounded finalized-transcript context, streaming suggestions, cancellation, and stale-context protection.
- Six immutable built-in meeting profiles—**General**, **Sales**, **Interview**, **Presentation**, **Leadership / negotiation**, and **Custom**—with quick actions that only prefill the explicit question and never send automatically.
- Up to 24 operating-system-encrypted private text or Markdown context packs, with no more than 12 exact revisions selected and frozen for one meeting.
- A Perssua-inspired but overt three-region meeting workspace: setup on the left, live transcript in the center, and Copilot/Debrief tabs on the right, with progressive rail collapse and a single-column narrow layout.
- Separate approval boundaries: every local transcription start requires an explicit recording-permission confirmation, while OpenAI receives context only after the meeting disclosure is accepted and the user explicitly chooses Send for that request.
- An optional compact companion overlay that defaults to an accessible, fully opaque presentation and shows only the two newest finalized transcript segments plus the latest explicitly requested suggestion.
- A fully local post-meeting debrief with six editable, source-linked sections, honest coverage states, and user-controlled Markdown copy/export.
- An overt Windows notification-area/macOS menu-bar experience with idle, preparing, recording, error, and stopped states; elapsed recording time; and native Stop, Show, Start-focus, and Quit actions.
- Opt-in close-to-tray, minimize-to-tray, and installed-app launch-at-sign-in behavior. Normal close still quits by default, normal minimize remains the default, and startup never begins capture.
- Separate source labels: **You** for the microphone and **Meeting audio** when no speaker cluster is available.
- In-memory audio only; raw meeting audio is not written to disk.
- Copy, manual Markdown export, and collision-safe automatic Markdown saving for finalized text.
- Opt-in, fully local English-to-Brazilian-Portuguese translation on Windows x64, with immediate original finals, asynchronous finalized-phrase translation, and bilingual Markdown export.
- A sandboxed Electron renderer, bounded UTF-8 JSONL sidecar protocol, and bounded inference queue.
- Deterministic fake-engine mode for UI development without loading a model.

Speaker labels are anonymous, provisional clusters—not identity recognition. This first live implementation labels each silence-delimited meeting-audio utterance and cannot reliably separate overlapping speakers or a speaker handoff without a pause. Manual names are session-local display aliases.

## Bootstrap from source

This is a one-command **source checkout** bootstrap, not a standalone app installation. Install these system prerequisites first:

- Node.js 22 or newer
- pnpm 10 or newer
- official CPython 3.12.x (Python 3.13 and newer are not currently supported)
- working microphone and output devices
- internet access for the first dependency install and each model that is not already cached

[Python 3.12.10](https://www.python.org/downloads/release/python-31210/) is the last Python 3.12 release with official Windows and macOS binary installers. Use the signed installer from that Python Software Foundation page. The bootstrap scripts do not download Python, use an OS package manager, request elevation, or change global Python packages.

From the repository root on Windows PowerShell:

```powershell
.\scripts\bootstrap.ps1
```

From the repository root on macOS:

```bash
bash ./scripts/bootstrap.sh
```

Each script locates the repository from its own path, so an absolute path to the script also works from another directory. It verifies the prerequisite versions, creates or reuses `backend/.venv`, installs the direct Python dependencies pinned in `backend/constraints.txt` plus the editable backend, checks the Python environment, installs exactly `pnpm-lock.yaml` with `--frozen-lockfile`, and runs the desktop source checks. Rerunning the command is safe. An existing virtual environment created with another Python series is left untouched and produces recovery guidance instead of being deleted.

Add the optional start flag to bootstrap and launch in the same command:

```powershell
.\scripts\bootstrap.ps1 -Start
```

```bash
bash ./scripts/bootstrap.sh --start
```

Otherwise, start later from the repository root with `pnpm start`. See [desktop/README.md](desktop/README.md) for permissions, model choices, environment overrides, privacy boundaries, and packaging notes. See [backend/README.md](backend/README.md) for a sidecar-only manual setup.

### Local engine check

The app's **Settings > Local engine** card runs a side-effect-free doctor check; it does not load or download a model. If Python is available but engine components are missing or broken in a source checkout, choose **Copy setup command**, run the copied bootstrap command in a terminal from the repository root, then choose **Check again**. If Python is missing or unsupported, **Open Python download page** opens a fixed official `python.org` page—it does not install Python. After installing Python, open a new terminal and restart the app if the running process still cannot see the updated `PATH`.

### Source build versus standalone distribution

Source contributors can keep using the bootstrap commands above. `pnpm run pack` and `pnpm run dist` now build a platform-specific PyInstaller `onedir` sidecar, generate a CycloneDX SBOM, and place both beside the Electron app resources. An installed app launches that bundled executable directly and never falls back to `PATH`, `MEETING_TRANSCRIBER_PYTHON`, a global interpreter, or the development fake. End users therefore do not need to install Python or run a bootstrap script.

Models are still intentionally provisioned on demand from the immutable commit/SHA-256 manifest. A new machine downloads only a feature's selected model, with the existing progress UI; installers do not silently carry several gigabytes of model files.

Ordinary `pack`/`dist` output is an unsigned developer distribution. `pnpm run dist:signed` uses a fail-closed electron-builder release configuration: Windows requires Authenticode credentials, while macOS requires Developer ID signing plus Apple notarization credentials. The repository also provides a manual signed-release workflow and a Windows/macOS ARM validation workflow. Credentials, notarization, clean-machine install/upgrade/repair/uninstall, and real macOS runtime behavior remain external release gates. See [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md).

For a deterministic desktop smoke run:

```powershell
$env:MEETING_TRANSCRIBER_FAKE = "1"
pnpm start
```

To exercise the entire Assist flow without a local model or OpenAI request, use a source build with both `MEETING_TRANSCRIBER_FAKE=1` and `MEETING_TRANSCRIBER_FAKE_ASSIST=1`. After the first bounded audio packet, the development fake sidecar emits finalized context while the meeting remains active; the fake Assist provider then streams a synthetic suggestion and performs no provider network call. Meeting-scoped consent is still required. Manual Review remains optional because the explicit Send preflight freezes the one-use pack automatically.

## Overt meeting workspace and companion overlay

The workspace keeps meeting controls and data visibly separated. On a wide window, the left setup rail contains source, model, language, profile, and private-context controls; the center contains the live transcript; and the right insight rail contains Copilot and Debrief tabs. At medium widths the setup rail moves above the transcript and can collapse. At narrow widths the regions stack into one column. The layout is inspired by meeting copilots such as Perssua, but this implementation remains visibly user-controlled.

Starting local transcription and sending data to OpenAI are different approval boundaries. Every **Start transcription** action opens a recording-permission confirmation that states capture is local and asks the user to confirm that meeting participants know and permission has been obtained. That confirmation never accepts the OpenAI disclosure. Conversely, selecting a profile, managing private packs, importing a key, opening Copilot, or reviewing context never starts recording or sends provider data. OpenAI is reached only when the meeting-scoped disclosure is accepted and the user explicitly chooses **Send** for that request.

The companion overlay starts hidden and does not reveal itself merely because backend preparation began. It can reveal without stealing focus only after the renderer confirms active transcription. Its truthful states are **Ready — not recording**, **Preparing — not recording**, **Recording and transcribing**, **Needs attention**, and **Stopped — not recording**. It projects at most the two newest finalized transcript segments, never drafts, plus the latest explicitly requested Copilot suggestion. The overlay cannot start audio capture, send an OpenAI request, receive private-pack bodies, or receive the API key; **Show workspace** and **Open Copilot** return the user to the full window for those actions.

The default **Accessible** mode is fully opaque, focusable, and visible in normal capture. Optional **Private** mode is a privacy aid, not stealth and not guaranteed invisibility: the app asks supported Windows or macOS capture APIs to protect the window, but some applications, operating-system versions, or capture methods may still show it. Private-mode opacity is limited to **60–100%**. Only the version, mode, opacity, window bounds, and display identity are persisted in the app's local overlay settings file; visibility and click-through state are not. Click-through is available only in Private mode, only while the Show/Hide recovery shortcut is registered, and it is disabled if that recovery path becomes unavailable.

Global overlay shortcuts are fixed and register independently, so one operating-system conflict does not disable the others:

| Action | Shortcut |
| --- | --- |
| Show or hide overlay | **Ctrl/Cmd+Shift+Space** |
| Focus Copilot in the full workspace | **Ctrl/Cmd+Shift+A** |
| Cancel the current Copilot request | **Ctrl/Cmd+Shift+Esc** |
| Increase private-mode opacity | **Ctrl/Cmd+Alt+Up** |
| Decrease private-mode opacity | **Ctrl/Cmd+Alt+Down** |
| Toggle private-mode click-through | **Ctrl/Cmd+Shift+X** |

Settings reports each shortcut as registered, unavailable, blocked, or unregistered. **Retry shortcuts** re-attempts unavailable registrations, with Show/Hide recovered before click-through; **Reset shortcuts** unregisters only this app's accelerators and restores the defaults. The overlay uses its own sandboxed, navigation-locked window and minimal preload API. Main validates the exact sender and bounded status shape at each IPC boundary, restores off-screen windows to an available display, and resets to an opaque, focusable, non-click-through safe position.

Suspend/resume, a stalled or muted capture source, a suspended audio context, and a failed main renderer now stop the affected meeting instead of silently presenting stale live state. The app cancels pending assistance, marks retained debrief context incomplete, clears autosave ownership, latches a visible error, and requires a fresh explicit Start. Overlay-renderer recovery is isolated from capture. These paths have deterministic coverage; real sleep/wake and renderer-crash behavior still require native acceptance.

The repository includes privacy-safe operator harnesses for the remaining native matrix: [overlay capture acceptance](docs/OVERLAY_CAPTURE_ACCEPTANCE.md), [Assist security acceptance](docs/ASSIST_SECURITY_ACCEPTANCE.md), and the [60-minute desktop soak](docs/DESKTOP-SOAK.md). Their reports are aggregate-only and fail closed. A plan, contract test, or short fake run cannot become release evidence.

## Local post-meeting debrief

After a meeting stops, open **Debrief** and choose **Generate local debrief** to create a deterministic extract from finalized original transcript text. Generation is never automatic. The result has six fixed sections: **Summary**, **Decisions**, **Action items**, **Open questions and risks**, **Important objections and questions**, and **Coaching observations**. Generated items keep local provenance and exact transcript-source timestamps. Source chips use the current speaker aliases and return to the supporting transcript segment.

This path is local by default and independent from hosted assistance. It does not use an LLM, provider network request, OpenAI consent or credentials, meeting profile, or private context pack. It cannot send an email, post a message, create a task, or perform another external action. Portuguese translations remain available in the transcript but are excluded from generated debrief claims and their source-linked Markdown; the original finalized text remains the evidence source.

The renderer keeps debrief edits in an ephemeral `DebriefStore`. Generated items can be edited or removed; this release does not expose an Add-item control. Action-item owner and due fields are explicitly labeled **Stated**, **Proposed**, or **Not stated** instead of implying an assignment. The bounded store recognizes **empty**, **manual**, **generating**, **ready**, **partial**, and **failed** states; an incomplete stop or bounded evidence produces an honest partial result rather than a silent complete claim.

The main process begins its separate `DebriefContextBuffer` only after the backend reports a successful start. It accepts finalized original segments and newer revisions, then retains the stopped meeting after either a complete or incomplete stop. A successful new meeting replaces the prior retained context. **Delete debrief source data…** is the separate explicit action that removes the retained context and current draft, after which regeneration is unavailable. The buffer and renderer draft never survive app exit; an explicit export creates a separate user-owned Markdown file.

**Copy Markdown** and **Export Markdown…** keep the current draft. Generating again while a draft exists asks before replacing its edits or removed items. **Clear debrief…** removes only that editable renderer draft, keeps the retained source data, and permits a fresh explicit generation. Hiding or restoring the transcript view, clearing a Copilot response, clearing the debrief draft, and deleting debrief source data are independently scoped. None silently deletes a user-owned Markdown file.

The bounded context retains at most 4,000 finalized segments and 1,000,000 original transcript characters. Extraction examines at most 20,000 statements, produces at most 12 items per section, and attaches at most 32 sources to one item. The renderer editor accepts at most 50 items per section and 4,000 characters per item. Copy and save reject debrief Markdown larger than 2 MB.

## Hosted AI assistance

Open **Settings > AI assistance** to leave hosted assistance **Off** or prepare the OpenAI API option. Local transcription stays independent. Selecting OpenAI or its fixed hosted model, choosing a meeting profile, creating, editing, or selecting private context, checking credential status, or importing a key makes no OpenAI request and sends no meeting data.

There is deliberately no API-key text field. Copy an OpenAI API key and choose **Import from clipboard**; Electron's main process trims surrounding whitespace, validates the key, encrypts it through the operating system, stores ciphertext only under the app's private user-data directory, and clears the clipboard only when the exact copied value is still present after a successful import. Windows uses DPAPI and macOS uses Keychain through Electron `safeStorage`. The sandboxed renderer receives only configured/unconfigured and encryption-availability status—it never receives the key, ciphertext, credential path, or raw storage errors. **Remove key** requires confirmation, revokes the saved ciphertext, and turns assistance Off.

Before starting transcription, choose one of the six immutable built-in profiles: **General**, **Sales**, **Interview**, **Presentation**, **Leadership / negotiation**, or **Custom**. These are versioned, app-owned response preferences with fixed limitations and compatible context categories; even **Custom** is a built-in profile, not an editable system prompt. Its quick actions only place suggested wording in the 1,000-character question field and focus it. They do not accept consent, start capture, or send anything; the user can edit the text and must still choose Send explicitly.

Private context packs contain local plain text or Markdown-formatted text in the objective, talking-points, job-description, resume, product-facts, presentation-notes, or custom-notes categories. Electron encrypts the complete versioned store with `safeStorage`—DPAPI on Windows and Keychain on macOS—and writes only ciphertext under the private app user-data directory. If OS secure storage is unavailable, pack creation and loading fail closed. An unreadable or invalid store is left untouched and disables pack changes without blocking the built-in profiles or local transcription. The current limits are 24 stored packs, 12 selected packs, 120 characters/240 UTF-8 bytes per name, 32,000 characters/65,536 UTF-8 bytes per pack body, and 262,144 UTF-8 bytes across all stored names and bodies.

Each create or update produces an exact pack revision. At meeting start, main resolves the chosen profile version and every selected pack ID/revision, rejects a missing or changed revision, and freezes that content for the session; the profile and pack controls remain locked until the meeting stops. Changing a profile, editing a pack, selecting packs, or importing a key is local setup and sends nothing. Private pack bodies never enter renderer Assist status or Review-context summaries: those surfaces receive only content-free profile metadata plus pack category, name, and byte counts.

The current hosted-model allowlist contains **GPT-5.6 Luna** and the transport is main-process-owned: a non-persistent Electron session can call only the fixed OpenAI Responses endpoint, rejects redirects, uses bounded streaming, and has no renderer-controlled endpoint, model ID, or system prompt. Off short-circuits before credential decryption, context construction, DNS, or fetch. No connection test runs during setup.

Hosted OpenAI model IDs are allowlisted, but they are not downloaded immutable artifacts and cannot use the repository's commit/SHA-256 manifest; OpenAI may update behavior behind a hosted model ID. The immutable revision and file-hash guarantee applies to downloaded local models only.

During an active meeting, open **Copilot** in the right insight rail. Opening, reviewing, or dismissing it sends nothing. Before each Send is eligible, the app requires the exact current main-owned disclosure to be accepted for that meeting. **Review context** optionally lets the user inspect the bounded transcript plus a content-free summary of the frozen profile and private packs, then return to the question. Every explicit Send preflight asks main to freeze a fresh one-use exact request pack and consumes that same object without silently taking another snapshot.

For that consent-gated Send only, main projects the user's explicit question together with the shown built-in profile, the private packs selected and frozen at meeting start, and original finalized transcript text with timestamps and source or anonymous-speaker labels. The provider context includes the profile's name, version, response style, fixed limitations, and app guidance; each selected pack's category, name, and body; and the bounded transcript fields. It excludes audio, provisional transcript text, translated text, unselected packs, local pack IDs/revisions, manual speaker aliases, and hidden conversation history. The API key stays out of the renderer and context pack; main decrypts it only for the approved request and uses it as the HTTPS Authorization credential to OpenAI.

The transcript portion is capped at the most recent 48 finalized segments, 15 minutes, and 12,000 transcript characters. A content-free request preview reports component sizes without exposing private pack bodies in Assist status or context summaries. If the complete serialized provider context—profile, selected packs, and transcript—would exceed 65,536 UTF-8 bytes, preview and Send fail closed before any provider request. The one-use request pack is consumed once; another question obtains another transcript snapshot while retaining the meeting-start profile and exact pack revisions, and meeting start/end clears any unused request pack. Requests are single-flight, have no queue or automatic retry, enforce a 20-second hard timeout and bounded output, and can be canceled without stopping transcription. Session, request, context-revision, and event-sequence identities keep late or superseded output out of the current result. If new finalized text arrives after the request pack is frozen, that pack does not change and the UI marks the answer as based on an earlier transcript revision. Provider output appears in a separate assistance result and never mutates the transcript.

The current OpenAI adapter streams provider text as one raw **Suggested response** channel. It does not claim structured transcript facts, supporting citations, or independently verified uncertainty labels. OpenAI API usage may be billed separately; the Settings and consent sections link to current Privacy, Data controls, and Usage pages instead of embedding a price. Live OpenAI calls have not yet been exercised in this workspace, and the Assist flow has not been runtime-validated on macOS hardware.

## Model choices

The default is **Small — Multilingual** with automatic language detection. The picker is generated from the bundled schema-v1 manifest instead of maintaining a separate renderer allowlist. Sizes below are approximate first-download sizes from that manifest.

Multilingual choices:

- **Tiny** — about 78 MB; very light and fastest, with the lowest accuracy.
- **Base** — about 148 MB; light and suitable for lower-resource machines.
- **Small** — about 486 MB; balanced and the current default.
- **Medium** — about 1.53 GB; high resource use and potentially higher accuracy.
- **Large v3 Turbo** — about 1.62 GB; high resource use with large-model quality and faster decoding.
- **Large v3** — about 3.09 GB; very high resource use and the maximum-quality profile.

English-only choices:

- **Tiny — English only** — about 78 MB.
- **Base — English only** — about 148 MB.
- **Small — English only** — about 486 MB.
- **Medium — English only** — about 1.53 GB.

Distilled English-only choices:

- **Distil Small — English only** — about 336 MB.
- **Distil Medium — English only** — about 792 MB.
- **Distil Large v3 — English only** — about 1.52 GB.
- **Distil Large v3.5 — English only** — about 1.52 GB.

The manifest marks language capability explicitly. The app does not infer it from a model-name suffix. An English-only model fixes the language to English; distilled models also use their required transcription settings. OpenAI reports the largest English-only advantage for Tiny and Base, with a smaller advantage for Small and Medium.

All models run locally on CPU with INT8 compute in this prototype. The resource labels are relative guidance, not RAM or latency guarantees. Medium, Turbo, and Large profiles may not stay near-live on a typical CPU.

Selecting a model saves the choice but never downloads it. Provisioning starts only after **Start transcription**. The app uses an app-owned cache and staging area, an operating-system lock, a full 40-character repository revision, and exact size and SHA-256 entries for every required model file. It verifies every cache hit, atomically promotes a new verified download, and fails closed without falling back to a mutable model. Verification has its own visible progress phase and may take time for multi-gigabyte models.

The same schema-v1 manifest covers all 14 ASR choices, the anonymous speaker model, and the translation model. The bootstrap and prerequisite doctor do not provision any model.

## Local English-to-pt-BR translation preview

Translation is opt-in and off by default. It is currently available only on Windows x64. The setting remains unavailable on macOS until the deterministic converted-model hashes have been reproduced and runtime behavior has been verified there.

The English transcript remains canonical. The app emits each original finalized segment as soon as ASR and speaker assignment finish, then translates that completed phrase on a separate bounded worker. A revision-matched translation update enriches the same visible row when it is ready; it is not a second transcript final and does not make Copilot or debrief context stale. The app translates only finalized segments that are explicitly English or that were auto-detected as English with confidence of at least `0.80`, and it never translates replaceable partial text. A translation preparation, inference, or backlog failure keeps the original transcript and allows the meeting to continue. A successful stop drains accepted translation work before automatic saving, so bilingual Markdown places the original English first and the available Brazilian-Portuguese translation below it.

On first use, the app downloads the exact **863,398,393-byte** Helsinki/Tatoeba Marian archive (about **823 MiB**), verifies its SHA-256 digest and every allowlisted archive member, then converts it locally with CTranslate2 4.8.1 to a verified INT8 model. The converted model is **245,130,608 bytes** in total (about **234 MiB**). Provisioning needs roughly **2.1 GB** of temporary free space; keep additional safety margin available. After provisioning, translation runs locally and does not require ChatGPT OAuth, an API key, or a translation service.

A one-sentence smoke translation took **0.109 seconds** on the validated Windows machine. More importantly, the v0.9.2 strict release-scope wall-clock backend soak exercised the first hour of a public multi-speaker English panel at the app's 200 ms packet granularity using `small.en`, online anonymous speaker clustering, and local pt-BR translation. All **287 non-empty finalized segments** carried a non-empty payload labeled pt-BR; one empty non-speech final was correctly skipped; no warning, inference error, or backpressure event occurred; and the decoder and sidecar both stopped cleanly with empty stderr. The evaluator returned `passed: true`, `acceptance_scope: release`, and no acceptance failures. This is historical sustained-pipeline evidence for the synchronous v0.9.2 event contract, not independent linguistic quality or validation of v0.10.0's asynchronous ordering. The earlier pre-gate run found and fixed a bug where one empty final previously disabled translation for the rest of the meeting.

That evidence validates the Windows sidecar's long-session ASR/translation path, not the whole desktop capture path. The strict run produced ten anonymous clusters, but a cluster count is load/stability evidence—not a diarization-accuracy pass; threshold and reconciliation work remain. The backend feed also bypasses Windows loopback selection, Electron capture/resampling/IPC, renderer reconciliation, and autosave. A one-hour YouTube-at-1x run through the actual app is still required for that separate end-to-end gate. Source, revision, file-hash, and license details are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## RAM and local performance

Small is reasonable for a desktop AI application, but it is not a tiny tray utility. A clean Windows 11 developer measurement on an Intel Core i7-12700H produced:

- about **502 MiB summed working set** for the idle Electron shell;
- about **506 MiB summed working set** for the warmed Python sidecar after real `small` INT8 transcription plus speaker embedding;
- about **1.0 GiB combined resident working set** for those two process trees;
- about **3.27 GiB combined private commit/reservation** reported by Windows. Private commit includes reserved/committed model memory and is not the same as physical RAM currently resident.

In the same synthetic probe, 8.41 seconds of English speech took 1.53 seconds for final ASR and 3.32 seconds for the first speaker-model preparation/assignment. Translation was not enabled for those memory measurements. This is one machine and one utterance, not a general throughput guarantee. The upstream faster-whisper benchmark reports 1,477 MB for Small INT8 CPU on an i7-12700K, which illustrates how much runtime and measurement method can change the number: [official faster-whisper benchmark](https://github.com/SYSTRAN/faster-whisper#benchmark).

The v0.9.2 strict release-scope hour run with `small.en` + speaker clustering + pt-BR translation measured the Python sidecar process tree separately: **1,341.5 MiB peak resident working set** and **4,773.1 MiB peak private commit**. Across 717 memory samples, median private commit was **4,342.7 MiB** in the first stable ten-minute window and **4,292.6 MiB** in the last ten minutes, a **50.1 MiB decrease** rather than a monotonic-growth signal. Final-event latency was 5.835 seconds p50, 7.985 seconds p95, and 9.535 seconds maximum overall; first-ten-minute p95 was 8.047 seconds and last-ten-minute p95 was 8.344 seconds. Real-time packet-send drift was 13 ms p95 and 47 ms maximum. Those historical final-event figures include ASR, translation, and diarization because v0.9.2 emitted them atomically. The v0.10.0 soak reports original-final latency separately from later translation completion, so a fresh same-media run is required before comparing latency numbers. Both measurements exclude the Electron process tree.

Use Base when lower memory is more important than accuracy. Small remains the balanced default. Medium should be treated as a high-memory profile and benchmarked on the target machine before a live meeting; it was not downloaded or measured in this workspace.

## Verify

Desktop checks:

```powershell
pnpm test
pnpm run check
```

Backend checks and the accelerated virtual soak:

```powershell
cd backend
$env:PYTHONPATH = (Resolve-Path .\src).Path
.\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
.\.venv\Scripts\python.exe tools\virtual_soak.py
```

The soak drives 60 virtual minutes through the queue and state machinery without retaining meeting audio. It is deliberately accelerated and count-based; it is not evidence of 60 minutes of wall-clock inference or a substitute for a real meeting. Before release, run an actual 60-minute Windows and macOS meeting and record first-partial latency, finalization latency, CPU, memory, dropped-audio behavior, and speaker-label stability.

The local debrief core passed 30 focused tests before desktop integration. A synthetic 60-minute, 4,000-segment benchmark extracted the bounded result in about **65 ms** on the validated Windows machine and reported **partial** when an evidence limit was reached. This measures deterministic extraction cost and limit handling only. It is not evidence of real-meeting debrief accuracy, speaker attribution, or false-positive quality.

For a real-media, wall-clock Windows sidecar soak, place an authorized local media file of at least one hour on disk and make sure `ffmpeg` is on `PATH`. From the repository root:

```powershell
$modelRoot = Join-Path $env:APPDATA 'meeting-transcriber-desktop\models'
.\backend\.venv\Scripts\python.exe .\backend\tools\real_media_soak.py `
  'C:\path\to\meeting.webm' `
  --model-root $modelRoot `
  --duration-seconds 3600
```

The harness uses the production JSONL sidecar, sends 16 kHz mono PCM in real-time 200 ms packets, runs `small.en`, local pt-BR translation, and anonymous speaker clustering, and emits only aggregate counts, original-final latency, translation-completion latency, memory, and sanitized issue codes. It correlates revision-matched translation updates without retaining their text, source filename, or raw PCM. Release-scope success requires exact packet delivery, bounded send drift and original-final latency, complete stable-window memory evidence, a confirmed clean shutdown with zero process errors, no critical event codes, no orphan/stale/duplicate translation updates, no translation on partial/empty finals, and a matching pt-BR update for every non-empty final. It does not evaluate translation meaning. This remains a sidecar test; play the source at 1x through the actual app to validate Windows loopback, Electron, the UI, and autosave.

## Why this is not a Vibe fork yet

[Vibe](https://github.com/thewh1teagle/vibe) remains the strongest reference for the desired cross-platform product shell and polish. Its recording flow was not a ready-made live PCM ingestion subsystem when this prototype was started. This smaller implementation validates live capture, local inference, speaker-label, and persistence contracts before inheriting a broader migration surface.

After real Windows and macOS meeting evidence, the next decision can be made with data: port this subsystem into a Vibe fork, or keep this shell and borrow only the product patterns needed. No upstream repository has been forked or modified here.

## Current boundary

The current source release is **v0.10.0**. It moves finalized-phrase translation off the sole ASR worker: original finals now reach the UI before local pt-BR inference, and exact session/segment/revision updates enrich them later without duplicating Assist or debrief context. Translation work is bounded and fail-soft, while stop drains every accepted update before renderer reconciliation and automatic saving. It retains v0.9.2's capture/runtime, provider, DPAPI, immutable-model, standalone-runtime, SBOM, and exact Windows/macOS package-layout hardening. The Windows bundle is still unsigned and not clean-machine-qualified; Developer ID signing, notarization, macOS hardware acceptance, the named capture-app matrix, a fresh asynchronous sidecar soak, and real 60-minute Windows/macOS desktop soaks remain external gates. The earlier Windows sidecar-only hour is historical synchronous-pipeline evidence and does not cover Electron capture, UI reconciliation, autosave, Portuguese semantic quality, or v0.10.0 latency. Hosted Assist remains explicit and source-implemented but has not been exercised against the live OpenAI API. Meeting detection, overlap-aware diarization, cross-session voice identity, automatic/background assistance, structured fact/citation presentation, provider-generated summaries, and a fully local generative model remain future work. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/DISTRIBUTION.md](docs/DISTRIBUTION.md), [docs/PLATFORM-COMPATIBILITY.md](docs/PLATFORM-COMPATIBILITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
