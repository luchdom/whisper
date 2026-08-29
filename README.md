<p align="center">
  <img src="desktop/build/icon.png" width="128" height="128" alt="Meeting Transcriber logo">
</p>

# Meeting Transcriber

A local-first Windows and macOS desktop prototype for transcribing meetings while they happen. It captures meeting audio and the microphone as separate tracks, streams them to a local Python process, and replaces provisional text with finalized segments in the UI.

## What works

- Live microphone and meeting-audio capture on the validated Windows 11 machine.
- Local `faster-whisper` transcription with 14 curated multilingual, English-only, and distilled model choices.
- A visible first-use loading bar with separate cache-check, download, verification, local-initialization, speaker-model, and translation-model phases.
- Auto-detect, English, and Portuguese language modes. Selecting an `.en` model fixes the language to English.
- Provisional anonymous labels for the meeting-audio track: **Speaker 1**, **Speaker 2**, and so on.
- In-place speaker renaming. A rename applies to every segment from that speaker for the current meeting and to the exported transcript.
- Local settings for speaker detection, transcript folder, and automatic saving after a successful stop.
- An opt-in hosted-assistance provider foundation with OpenAI Off by default, a fixed model allowlist, operating-system encrypted API-key storage, and no connection test or transcript upload during configuration. The actual Assist flow is a later milestone.
- An overt Windows notification-area/macOS menu-bar experience with idle, preparing, recording, error, and stopped states; elapsed recording time; and native Stop, Show, Start-focus, and Quit actions.
- Opt-in close-to-tray, minimize-to-tray, and installed-app launch-at-sign-in behavior. Normal close still quits by default, normal minimize remains the default, and startup never begins capture.
- Separate source labels: **You** for the microphone and **Meeting audio** when no speaker cluster is available.
- In-memory audio only; raw meeting audio is not written to disk.
- Copy, manual Markdown export, and collision-safe automatic Markdown saving for finalized text.
- Opt-in, fully local English-to-Brazilian-Portuguese translation on Windows x64, with the original English preserved and bilingual Markdown export.
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

`pnpm run pack` and `pnpm run dist` are developer packaging checks today. Their output includes the backend source, constraints, and model manifest, but does not bundle a Python interpreter, native Python dependencies, bootstrap scripts, or model artifacts. Those artifacts are therefore **not standalone installers for a clean machine**. A genuinely standalone release still requires a bundled, signed, platform-specific runtime and clean-machine Windows and macOS validation.

For a deterministic desktop smoke run:

```powershell
$env:MEETING_TRANSCRIBER_FAKE = "1"
pnpm start
```

## Hosted AI assistance foundation

Open **Settings > AI assistance** to leave hosted assistance **Off** or prepare the OpenAI API option. Local transcription stays independent. Selecting OpenAI, selecting the fixed hosted model, checking credential status, or importing a key makes no OpenAI request and sends no meeting data.

There is deliberately no API-key text field. Copy an OpenAI API key and choose **Import from clipboard**; Electron's main process trims surrounding whitespace, validates the key, encrypts it through the operating system, stores ciphertext only under the app's private user-data directory, and clears the clipboard only when the exact copied value is still present after a successful import. Windows uses DPAPI and macOS uses Keychain through Electron `safeStorage`. The sandboxed renderer receives only configured/unconfigured and encryption-availability status—it never receives the key, ciphertext, credential path, or raw storage errors. **Remove key** requires confirmation, revokes the saved ciphertext, and turns assistance Off.

The current hosted-model allowlist contains **GPT-5.6 Luna** and the transport is main-process-owned: a non-persistent Electron session can call only the fixed OpenAI Responses endpoint, rejects redirects, uses bounded streaming, and has no renderer-controlled endpoint, model ID, or system prompt. Off short-circuits before credential decryption, context construction, DNS, or fetch. No connection test runs during setup, and there is no Assist button in this version, so the application cannot send a transcript yet.

Hosted OpenAI model IDs are allowlisted, but they are not downloaded immutable artifacts and cannot use the repository's commit/SHA-256 manifest; OpenAI may update behavior behind a hosted model ID. The immutable revision and file-hash guarantee applies to downloaded local models only.

The in-app disclosure is main-owned and versioned. The planned request flow will require meeting-specific consent and will send only finalized transcript excerpts plus the user's question—never audio, drafts, or unconfirmed text. OpenAI API usage may be billed separately; the Settings section links to current Privacy, Data controls, and Usage pages instead of embedding a price.

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

The English transcript remains canonical. The app translates only finalized segments that are explicitly English or that were auto-detected as English with confidence of at least `0.80`. It never translates replaceable partial text. A translation preparation or inference failure keeps the original transcript, reports translation as unavailable, and allows the meeting to continue. Bilingual Markdown places the original English first and the Brazilian-Portuguese translation below it.

On first use, the app downloads the exact **863,398,393-byte** Helsinki/Tatoeba Marian archive (about **823 MiB**), verifies its SHA-256 digest and every allowlisted archive member, then converts it locally with CTranslate2 4.8.1 to a verified INT8 model. The converted model is **245,130,608 bytes** in total (about **234 MiB**). Provisioning needs roughly **2.1 GB** of temporary free space; keep additional safety margin available. After provisioning, translation runs locally and does not require ChatGPT OAuth, an API key, or a translation service.

A one-sentence smoke translation took **0.109 seconds** on the validated Windows machine. More importantly, the strict release-scope wall-clock backend soak exercised the first hour of a public multi-speaker English panel at the app's 200 ms packet granularity using `small.en`, online anonymous speaker clustering, and local pt-BR translation. All **287 non-empty finalized segments** carried a non-empty payload labeled pt-BR; one empty non-speech final was correctly skipped; no warning, inference error, or backpressure event occurred; and the decoder and sidecar both stopped cleanly with empty stderr. The evaluator returned `passed: true`, `acceptance_scope: release`, and no acceptance failures. This is strong translation-payload and sustained-pipeline evidence, not independent linguistic quality. The earlier pre-gate run found and fixed a bug where one empty final previously disabled translation for the rest of the meeting.

That evidence validates the Windows sidecar's long-session ASR/translation path, not the whole desktop capture path. The strict run produced ten anonymous clusters, but a cluster count is load/stability evidence—not a diarization-accuracy pass; threshold and reconciliation work remain. The backend feed also bypasses Windows loopback selection, Electron capture/resampling/IPC, renderer reconciliation, and autosave. A one-hour YouTube-at-1x run through the actual app is still required for that separate end-to-end gate. Source, revision, file-hash, and license details are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## RAM and local performance

Small is reasonable for a desktop AI application, but it is not a tiny tray utility. A clean Windows 11 developer measurement on an Intel Core i7-12700H produced:

- about **502 MiB summed working set** for the idle Electron shell;
- about **506 MiB summed working set** for the warmed Python sidecar after real `small` INT8 transcription plus speaker embedding;
- about **1.0 GiB combined resident working set** for those two process trees;
- about **3.27 GiB combined private commit/reservation** reported by Windows. Private commit includes reserved/committed model memory and is not the same as physical RAM currently resident.

In the same synthetic probe, 8.41 seconds of English speech took 1.53 seconds for final ASR and 3.32 seconds for the first speaker-model preparation/assignment. Translation was not enabled for those memory measurements. This is one machine and one utterance, not a general throughput guarantee. The upstream faster-whisper benchmark reports 1,477 MB for Small INT8 CPU on an i7-12700K, which illustrates how much runtime and measurement method can change the number: [official faster-whisper benchmark](https://github.com/SYSTRAN/faster-whisper#benchmark).

The strict release-scope hour run with `small.en` + speaker clustering + pt-BR translation measured the Python sidecar process tree separately: **1,341.5 MiB peak resident working set** and **4,773.1 MiB peak private commit**. Across 717 memory samples, median private commit was **4,342.7 MiB** in the first stable ten-minute window and **4,292.6 MiB** in the last ten minutes, a **50.1 MiB decrease** rather than a monotonic-growth signal. Final-event latency was 5.835 seconds p50, 7.985 seconds p95, and 9.535 seconds maximum overall; first-ten-minute p95 was 8.047 seconds and last-ten-minute p95 was 8.344 seconds. Real-time packet-send drift was 13 ms p95 and 47 ms maximum. These figures include ASR, translation, and diarization but exclude the Electron process tree.

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

For a real-media, wall-clock Windows sidecar soak, place an authorized local media file of at least one hour on disk and make sure `ffmpeg` is on `PATH`. From the repository root:

```powershell
$modelRoot = Join-Path $env:APPDATA 'meeting-transcriber-desktop\models'
.\backend\.venv\Scripts\python.exe .\backend\tools\real_media_soak.py `
  'C:\path\to\meeting.webm' `
  --model-root $modelRoot `
  --duration-seconds 3600
```

The harness uses the production JSONL sidecar, sends 16 kHz mono PCM in real-time 200 ms packets, runs `small.en`, local pt-BR translation, and anonymous speaker clustering, and emits only aggregate counts, latency, memory, and sanitized issue codes. It never emits the source filename, transcript text, or raw PCM. Release-scope success requires exact packet delivery, bounded send drift and final latency, complete stable-window memory evidence, a confirmed clean shutdown with zero process errors, no critical event codes, no translation on partial/empty finals, and a non-empty pt-BR-labeled translation payload for every non-empty final. It does not evaluate translation meaning. This remains a sidecar test; play the source at 1x through the actual app to validate Windows loopback, Electron, the UI, and autosave.

## Why this is not a Vibe fork yet

[Vibe](https://github.com/thewh1teagle/vibe) remains the strongest reference for the desired cross-platform product shell and polish. Its recording flow was not a ready-made live PCM ingestion subsystem when this prototype was started. This smaller implementation validates live capture, local inference, speaker-label, and persistence contracts before inheriting a broader migration surface.

After real Windows and macOS meeting evidence, the next decision can be made with data: port this subsystem into a Vibe fork, or keep this shell and borrow only the product patterns needed. No upstream repository has been forked or modified here.

## Current boundary

The repository has a one-command source bootstrap, but does not yet ship a standalone bundled Python/model runtime. The Windows sidecar has passed its strict 60-minute release-scope ASR/translation/diarization-load gate. The actual desktop capture/autosave path and all macOS capture/performance behavior remain runtime-unverified, and Portuguese semantic quality was not scored by the payload-focused soak. Local translation remains Windows x64-only until its deterministic artifacts and behavior are verified on macOS. The tray lifecycle has deterministic Windows/macOS policy coverage, but its macOS menu-bar and login-item behavior still requires actual-hardware validation. Signing, notarization, meeting detection, overlap-aware diarization, cross-session voice identity, summaries, and an in-meeting copilot remain future work. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the replaceable-engine boundary and staged roadmap, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for model attribution and immutable source identities.
