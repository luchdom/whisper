# Meeting transcriber sidecar

This package is the headless transcription half of the meeting prototype. It accepts two already-captured audio tracks over stdin, segments speech independently, runs local `faster-whisper` inference, optionally assigns anonymous speaker clusters to meeting-audio utterances with `sherpa-onnx`, and writes transcript events to stdout. It does **not** capture Windows or macOS audio itself; the desktop process owns capture and resampling.

The track labels are intentionally modest:

- `system` means **Meeting audio**.
- `microphone` means **You**.

When online diarization is disabled or unavailable, this remains source-based labeling and `speaker_id` is `null`. When enabled, system-track utterances may receive meeting-scoped IDs such as `speaker-01`. These are provisional clusters, not identity recognition. Microphone segments remain source-labeled as **You**.

## Setup

Official CPython 3.12.x is required; Python 3.13 and newer are not currently supported. Use a project-local virtual environment and do not install the sidecar globally. The supported full-checkout path is the one-command bootstrap from the repository root:

```powershell
.\scripts\bootstrap.ps1
```

```bash
bash ./scripts/bootstrap.sh
```

The bootstrap creates or reuses `backend/.venv`, installs the editable backend under the direct dependency pins in `constraints.txt`, verifies the environment without loading a model, and prepares the desktop dependencies. It never installs Python or changes global Python packages. If Python is missing, use the signed installer on the official [Python 3.12.10 release page](https://www.python.org/downloads/release/python-31210/) and rerun the bootstrap from a new terminal.

## Standalone sidecar

Desktop distributions do not run this source tree. `pnpm run build:sidecar` installs the exact build-only versions in `packaging/requirements-build.txt` into the project virtual environment, then uses PyInstaller `onedir` mode to bundle CPython and the native inference dependencies for the current OS and architecture. `packaging/sidecar_entry.py` preserves the same stdin/stdout JSONL protocol.

The hidden `--setup-probe` command imports the required runtime components and returns only the existing version/component sentinel. It does not load or download a model, inspect meeting content, or start the JSONL loop. The build script requires that probe and a real JSONL shutdown smoke to pass before Electron packaging. Installed desktop builds launch only the bundled executable and never fall back to system Python; source mode continues to use the bootstrap behavior above. See [../docs/DISTRIBUTION.md](../docs/DISTRIBUTION.md) for signing and clean-machine release gates.

For sidecar-only development, the equivalent manual commands are below.

Windows PowerShell:

```powershell
cd backend
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install --disable-pip-version-check --no-input --constraint constraints.txt --editable .
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -I -B -c "import meeting_transcriber, ctranslate2, faster_whisper, huggingface_hub, sentencepiece, sherpa_onnx"
.\.venv\Scripts\meeting-transcriber.exe
```

macOS:

```bash
cd backend
python3.12 -m venv .venv
.venv/bin/python -m pip install --disable-pip-version-check --no-input --constraint constraints.txt --editable .
.venv/bin/python -m pip check
.venv/bin/python -I -B -c 'import meeting_transcriber, ctranslate2, faster_whisper, huggingface_hub, sentencepiece, sherpa_onnx'
.venv/bin/meeting-transcriber
```

The virtual-environment module form is equivalent:

```bash
backend/.venv/bin/python -m meeting_transcriber
```

On Windows, use `backend\.venv\Scripts\python.exe -m meeting_transcriber`. The app's **Settings > Local engine** doctor performs the same kind of import-only prerequisite check with a bounded timeout and sanitized environment. It does not construct an engine, load a model, or access the network.

`faster-whisper` and its model are loaded only after a `start` command. `model` must be one of the 14 public IDs in the bundled schema-v1 manifest; arbitrary repository names and local paths are rejected. The engine resolves that ID to a full 40-character upstream revision, verifies every manifested file and SHA-256 digest on every cache hit, and downloads a miss into a locked sibling staging directory before atomic promotion. A corrupt cache fails closed and is never silently replaced or redirected to a mutable fallback. `download_root` selects the main-process-owned model root; the platform cache is used when it is `null`. Audio and transcripts are never sent to an ASR API by this package.

Online diarization uses the manifest-pinned `wespeaker_en_voxceleb_CAM++.onnx` sherpa-onnx release. Its first use downloads about 29 MB to the requested local model path or platform cache. The shared provisioner checks disk space, uses an operating-system lock and sibling staging file, and verifies the exact byte length and SHA-256 digest before atomic promotion and every later load. If download or initialization fails, the service emits one recoverable `diarization_unavailable` warning for that session and transcription continues without speaker IDs. See [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

For a deterministic UI smoke test that imports neither `faster-whisper` nor NumPy, run:

```bash
python -m meeting_transcriber --engine fake
```

The fake engine must be selected explicitly and produces conspicuous test text. It is not a transcription engine.

## JSON Lines protocol

stdin and stdout carry one UTF-8 JSON object per line. stdout is protocol-only. Commands use `type`; unknown fields and malformed packets produce a recoverable protocol `error` event. Blank input lines are ignored.

### Lifecycle commands

All engine fields are optional. `start` fields override the latest configuration.

```json
{"type":"configure","model":"small","language":null,"device":"auto","compute":"default","download_root":null,"diarization":"off","diarization_model":null,"translation":"off","translation_model":null}
{"type":"start","model":"small.en","language":"en","device":"cpu","compute":"int8","download_root":"C:/app-data/models/asr","diarization":"online","diarization_model":"C:/app-data/models/wespeaker_en_voxceleb_CAM++.onnx","translation":"en_to_pt_br","translation_model":"C:/app-data/models/translation"}
{"type":"flush"}
{"type":"stop"}
{"type":"shutdown"}
```

- `model`: one public ID from the bundled immutable model manifest. Default: `small`.
- `language`: a Whisper language code, `"auto"`, or `null` for detection. Default: `null`.
- `device`: for example `auto`, `cpu`, or `cuda`. Default: `auto`.
- `compute`: a CTranslate2 compute type such as `default`, `int8`, or `float16`. Default: `default`.
- `download_root`: main-process-owned model root, or `null` for the platform app cache.
- `diarization`: exactly `off` or `online`. Default: `off`.
- `diarization_model`: local WeSpeaker ONNX path, or `null` for the platform cache path.
- `translation`: exactly `off` or `en_to_pt_br`. Default: `off`.
- `translation_model`: main-process-owned absolute translation-model root supplied when translation is enabled; otherwise it may be `null`. A missing or invalid root makes translation unavailable for that session without blocking ASR.

`start` is deliberately synchronous: it emits `loading`, prepares the ASR model and enabled optional models, and emits `ready` only when capture may begin. An ASR preparation or integrity failure emits the sanitized `engine_initialization_failed` error and `unavailable`; no session is started. Speaker or translation preparation fails soft with one sanitized warning, and the original transcription session still reaches `ready`.

`flush` finalizes current speech and waits for its final events, then emits `flushed`; capture can continue in the same session. `stop` already performs a flush, waits for all final inference jobs, then emits `session_stopped`. `shutdown` stops an active session, closes the worker and model, emits `shutdown`, and exits. A client should send `stop` or `flush`, not `stop` followed by `flush`.

### Audio command

```json
{"type":"audio","track":"system","start_ms":1200,"end_ms":1300,"pcm_s16le_base64":"..."}
```

- Audio is fixed at 16,000 Hz, mono, signed 16-bit little-endian PCM.
- `track` is exactly `system` or `microphone`.
- `start_ms` is a non-negative monotonic session timestamp, independently monotonic and non-overlapping per track.
- `end_ms` is optional. When present, it must equal `start_ms + round(sample_count * 1000 / 16000)`.
- `pcm_s16le_base64` is required, non-empty base64. A single packet is limited to ten seconds.

The desktop currently sends 200 ms packets. Gaps of at least one second generate a capture warning. Invalid or overlapping timing generates a recoverable capture error and the packet is ignored.

### Events

Engine state:

```json
{"type":"engine_status","status":"ready","session_id":"...","model":"small","language":null,"device":"auto","compute":"default"}
```

Status values are `configured`, `loading`, `ready`, `unavailable`, `flushed`, and `shutdown`.

Model preparation emits phase events between `loading` and `ready`:

```json
{"type":"model_progress","phase":"checking_cache","session_id":"..."}
{"type":"model_progress","phase":"downloading","session_id":"..."}
{"type":"model_progress","phase":"verifying","session_id":"..."}
{"type":"model_progress","phase":"initializing","session_id":"..."}
{"type":"model_progress","phase":"preparing_speakers","session_id":"..."}
{"type":"model_progress","phase":"checking_translation_cache","session_id":"..."}
{"type":"model_progress","phase":"downloading_translation","session_id":"..."}
{"type":"model_progress","phase":"verifying_translation","session_id":"..."}
{"type":"model_progress","phase":"converting_translation","session_id":"..."}
{"type":"model_progress","phase":"initializing_translation","session_id":"..."}
```

The first four phases describe the ASR model. `preparing_speakers` is emitted only when anonymous speaker detection is enabled. Translation phases are emitted only for the opt-in translation mode and can include a first-use download and deterministic local conversion. The events intentionally contain no cache path, URL, token, filename, or invented percentage; clients should render them as indeterminate progress until `ready` or `unavailable`.

Partial and final transcript events have the same segment shape:

```json
{"type":"partial_transcript","session_id":"session","segment":{"id":"session:system:000001","revision":1,"start_ms":1000,"end_ms":1800,"track":"system","text":"working text","partial":true,"final":false,"language":"en","speaker_id":"speaker-01","translated_text":null,"translated_language":null}}
{"type":"final_segment","session_id":"session","segment":{"id":"session:system:000001","revision":2,"start_ms":1000,"end_ms":2300,"track":"system","text":"final text","partial":false,"final":true,"language":"en","speaker_id":"speaker-01","translated_text":"texto final","translated_language":"pt-BR"}}
```

Top-level `session_id` is required and is copied from the immutable inference job. A client should discard transcript events whose session does not match its active session, including late events from a process being retried. `id` stays stable across revisions of one utterance. `revision` increases for every scheduled rolling decode; a skipped number is valid when backpressure coalesces a stale partial. An already accepted final is never removed from the inference queue. The renderer should replace a segment only with a higher revision for the same `id`.

`speaker_id` is either `null` or an opaque meeting-scoped value. A partial keeps its first assigned ID through finalization so the visible label does not jump during a turn. A client may map IDs to friendly aliases such as **Speaker 1**, but must not treat them as stable people across meetings.

`text` is always the canonical original transcript. Partials never carry a translation. An eligible final carries its original and translation atomically in the same event: `translated_language` is exactly `pt-BR` when `translated_text` is present, and both fields are `null` otherwise. Translation is attempted only for explicit/English-only input or auto-detected English with a finite confidence of at least `0.80`.

Warnings and errors never contain audio or transcript text:

```json
{"type":"warning","source":"capture","code":"audio_gap","message":"A 1200 ms gap was detected on the system track","recoverable":true}
{"type":"warning","source":"transcription","code":"diarization_unavailable","message":"Anonymous speaker labels are unavailable for this session; transcription will continue","recoverable":true}
{"type":"warning","source":"transcription","code":"translation_unavailable","message":"Brazilian Portuguese translation is unavailable for this meeting; original transcription will continue","recoverable":true}
{"type":"error","source":"transcription","code":"inference_failed","message":"Transcription failed for a local segment.","recoverable":true,"segment_id":"..."}
{"type":"error","source":"transcription","code":"inference_backpressure","message":"Transcription stopped because the local inference audio buffer reached its configured limit","recoverable":false}
```

`source` is `protocol`, `capture`, or `transcription`. A transcription error can include `segment_id`. `inference_backpressure` is emitted once and contains no PCM, transcript, participant, path, or model details.

Session completion:

```json
{"type":"session_stopped","session_id":"...","reason":"stopped"}
```

After inference overload, stop uses `reason: "inference_backpressure"` instead. It drains every job accepted before the overload before emitting this event. If any accepted final decode fails, stop uses `reason: "final_inference_failed"`. Both reasons mark the session incomplete so the desktop does not automatically save it as a successful transcript. Completed segments remain available for manual export; a visible unfinished draft is review-only and is not exported as final text.

## Segmentation, speaker clustering, and current streaming limitations

The spike uses packet-level RMS VAD with 240 ms pre-roll, 650 ms silence finalization, partial inference about every 700 ms, and a 15-second maximum utterance. System and microphone state never mix. Pending partial jobs are coalesced under backpressure, while accepted final jobs are retained. A clean stop turns any active speech into a final job and waits for it.

Queued and currently-running inference PCM share a 32 MiB budget by default. Removing or coalescing a partial releases its accounted bytes immediately. New partials can be discarded to stay within the budget. Accepted finals are never removed; if a new final cannot fit even after queued partials are removed, it is not accepted, one non-recoverable `inference_backpressure` error is emitted, and the session stops accepting audio. The next `stop` skips another flush attempt, drains accepted work, and reports the overload reason. A later session starts with clean overload state and an empty queue.

`faster-whisper` is not used as a stateful streaming ASR model here. Every partial is a rolling re-decode of the current utterance, so interim text can change and CPU/GPU cost grows until finalization. This is appropriate for a working spike, but a true streaming recognizer may be a later optimization.

Online diarization runs only on the `system` track. Each inference utterance is embedded locally, compared by cosine similarity with up to 16 in-memory meeting clusters, and assigned a stable anonymous ID. Cluster centroids and partial assignments are bounded; raw diarization PCM is not retained after the embedding call. All cluster state is cleared on stop and cannot identify a person in a later meeting.

This is turn-level incremental clustering, not a full overlap-aware diarization pipeline. Because the RMS segmenter establishes utterance boundaries before clustering, two overlapping participants or a speaker switch with no pause may be assigned as one turn. Similar voices may merge and one voice may split. A later optional full-meeting reconciliation pass would require an explicit retention design because this version intentionally does not keep raw audio.

The orchestration depends on a small replaceable engine interface (`configure`, `prepare`, `transcribe`, `close`). A future local HTTP/SSE sidecar can implement that boundary in place of faster-whisper. No WhoSpeaks or other remote-sidecar dependency is included now.

## Local English-to-pt-BR translation preview

Translation is opt-in, defaults to `off`, and is currently gated to Windows x64. When `en_to_pt_br` is enabled, the sidecar provisions the exact 863,398,393-byte allowlisted OPUS-MT archive over HTTPS, verifies its SHA-256 digest and all 13 expected archive members, extracts only the conversion inputs, and converts them locally with pinned CTranslate2 4.8.1 INT8. It then verifies the exact converted output manifest before atomic promotion. The first conversion requires roughly 2.1 GB of free staging space; the verified runtime model is about 234 MiB.

Finalized eligible English is tokenized with SentencePiece 0.2.2 using the separate `>>pob<<` target token. Input is limited to 4,000 characters and 512 total source pieces, output to 512 pieces, and inference to a batch of one. Original text remains canonical. An empty finalized ASR segment is treated as silence/non-speech and skipped without disabling translation for later speech. Preparation or genuine per-segment translation errors emit at most one sanitized `translation_unavailable` warning per session, keep the original-only final event, and do not set `final_inference_failed`. macOS translation remains disabled until deterministic converted outputs and runtime behavior are verified there. Source identity and licenses are recorded in [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

## Privacy

- Raw PCM is held in memory only long enough to segment and infer; this package does not save recordings.
- Speaker embeddings are biometric-derived data. They stay in memory, are never emitted or logged, and are cleared at session end.
- Anonymous speaker IDs and manual display aliases are meeting-scoped; there is no voice enrollment or cross-meeting identity store.
- Transcript text is emitted only over stdout to the parent process and is not logged to stderr.
- No audio or transcript content is included in warning/error messages.
- There is no cloud ASR call or analytics/telemetry integration.
- Initial model provisioning can access the network when a manifest-selected model is not cached. A fully verified app-owned cache can start offline; arbitrary pre-provisioned model paths are not accepted.
- The parent application remains responsible for visible recording consent, retention controls, OS capture permission, and secure persistence if it chooses to save transcripts.

## Tests

The test suite uses only the deterministic fake engine, performs no model download, and makes no network calls:

Windows PowerShell:

```powershell
cd backend
$env:PYTHONPATH = (Resolve-Path .\src).Path
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

macOS:

```bash
cd backend
PYTHONPATH=src .venv/bin/python -m unittest discover -s tests -v
```

An accelerated virtual-audio soak exercises 60 virtual minutes of segmentation, queue drainage, and bounded counting state:

```powershell
.\.venv\Scripts\python.exe tools\virtual_soak.py
```

```bash
.venv/bin/python tools/virtual_soak.py
```

The command explicitly reports `accelerated_virtual_audio_not_a_real_meeting`. It compresses the carrier data and does not run 60 minutes of model inference in wall-clock time. It is a regression harness, not the real Windows/macOS 60-minute meeting acceptance test.

### Real-media Windows sidecar soak

Use an authorized local media file of at least one hour and install `ffmpeg` on `PATH`. From the repository root:

```powershell
$modelRoot = Join-Path $env:APPDATA 'meeting-transcriber-desktop\models'
.\backend\.venv\Scripts\python.exe .\backend\tools\real_media_soak.py `
  'C:\path\to\meeting.webm' `
  --model-root $modelRoot `
  --duration-seconds 3600
```

The harness launches the production JSONL sidecar, waits for verified models to become ready, decodes the selected interval to mono 16 kHz signed PCM, and sends exactly paced 200 ms system-audio packets. It enables `small.en`, local pt-BR translation, and online anonymous speaker clustering by default. It retains no transcript text or raw PCM, omits the source filename, and prints only progress plus an aggregate JSON result. Release-scope acceptance requires exact packet delivery, bounded feed drift and final latency, at least 600 process-tree memory samples with at least 60 in each stable window, a confirmed clean sidecar shutdown and zero exit status, empty stderr streams, no critical event codes, no translated partial or empty finals, a non-empty pt-BR-labeled payload on every non-empty final, and no more than 256 MiB private-memory growth between the stable windows. Payload coverage does not independently validate Portuguese meaning; short `--allow-short` runs are smoke tests and do not claim release memory evidence.

This exercises VAD, queueing, ASR, translation, diarization load, the sidecar protocol, and wall-clock stability. On the validated Windows machine, the strict 60-minute run delivered all 18,000 packets, translated all 287 non-empty finals, skipped one empty final, emitted no warnings or errors, shut down cleanly with empty stderr, stayed within the drift/latency/memory limits, and returned `passed: true` with no acceptance failures. A cluster count is still not diarization-accuracy evidence: the run produced ten anonymous clusters without establishing that they correspond to ten real people, so clustering thresholds and later reconciliation still require tuning. The harness does **not** exercise Windows loopback selection, `getDisplayMedia`, AudioWorklet downmix/resampling, Electron IPC, renderer reconciliation, or autosave. Play the same source at 1x through the actual desktop app for that end-to-end gate. A public multi-speaker panel is useful controlled input, but it is cleaner than a real call and does not reproduce device changes, conferencing-network artifacts, microphone echo, or arbitrary overlap.
