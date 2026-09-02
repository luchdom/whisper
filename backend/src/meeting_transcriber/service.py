"""Session orchestration and the stdin/stdout JSON Lines application."""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
import io
from queue import Full, Queue
import threading
import uuid
from typing import TextIO

from .diarization import NoOpSpeakerDiarizer, OnlineSpeakerDiarizer, SpeakerDiarizer
from .engine import EngineSettings, ModelLoadProgress, TranscriptionEngine
from .model_manifest import get_model_manifest
from .protocol import (
    AudioCommand,
    ConfigureCommand,
    FlushCommand,
    MAX_SEGMENT_TEXT_CHARS,
    ProtocolError,
    SegmentPayload,
    ShutdownCommand,
    StartCommand,
    StopCommand,
    issue_event,
    parse_command,
    segment_event,
    segment_translation_event,
    serialize_event,
)
from .queueing import CoalescingJobQueue, DEFAULT_MAX_BUFFERED_PCM_BYTES, InferenceBackpressureError
from .segmentation import InferenceJob, SegmentationConfig, SegmentationError, UtteranceSegmenter
from .translation import (
    LocalCTranslate2Translator,
    NoOpTranslator,
    TRANSLATED_LANGUAGE,
    TranslatorProtocol,
    is_auto_detected_english,
)


EventSink = Callable[[dict[str, object]], None]
DiarizerFactory = Callable[[EngineSettings], SpeakerDiarizer]
TranslatorFactory = Callable[[EngineSettings], TranslatorProtocol]
DEFAULT_MAX_PENDING_TRANSLATIONS = 32


@dataclass(frozen=True, slots=True)
class _TranslationJob:
    session_generation: int
    session_id: str
    segment_id: str
    segment_revision: int
    text: str


class TranscriptionService:
    def __init__(
        self,
        engine: TranscriptionEngine,
        event_sink: EventSink,
        *,
        segmentation_config: SegmentationConfig | None = None,
        session_id_factory: Callable[[], str] | None = None,
        max_inference_pcm_bytes: int = DEFAULT_MAX_BUFFERED_PCM_BYTES,
        max_pending_translations: int = DEFAULT_MAX_PENDING_TRANSLATIONS,
        diarizer_factory: DiarizerFactory | None = None,
        translator_factory: TranslatorFactory | None = None,
    ) -> None:
        if max_pending_translations <= 0:
            raise ValueError("max_pending_translations must be positive")
        self.engine = engine
        self.event_sink = event_sink
        self.settings = EngineSettings()
        self.segmentation_config = segmentation_config or SegmentationConfig()
        self.session_id_factory = session_id_factory or (lambda: uuid.uuid4().hex)
        self.diarizer_factory = diarizer_factory or _default_diarizer_factory
        self.translator_factory = translator_factory or _default_translator_factory
        self.queue = CoalescingJobQueue(
            max_pending_partials=2,
            max_buffered_pcm_bytes=max_inference_pcm_bytes,
        )
        self._segmenter: UtteranceSegmenter | None = None
        self._session_id: str | None = None
        self._last_end_ms: dict[str, int] = {}
        self._engine_ready = False
        self._diarizer: SpeakerDiarizer = NoOpSpeakerDiarizer()
        self._diarizer_key: tuple[str, str | None] | None = None
        self._diarization_available = False
        self._diarization_warning_emitted = False
        self._translator: TranslatorProtocol = NoOpTranslator()
        self._translator_key: tuple[str, str | None] | None = None
        self._translation_available = False
        self._translation_warning_emitted = False
        self._translation_backpressure_warning_emitted = False
        self._translation_queue: Queue[_TranslationJob | None] = Queue(
            maxsize=max_pending_translations
        )
        self._translation_state_lock = threading.Lock()
        self._session_generation = 0
        self._final_segment_revisions: dict[tuple[str, str], int] = {}
        self._session_overloaded = False
        self._final_inference_failed = False
        self._shutdown = False
        progress_setter = getattr(self.engine, "set_progress_sink", None)
        if callable(progress_setter):
            progress_setter(self._emit_model_progress)
        self._worker = threading.Thread(target=self._worker_loop, name="transcription-worker", daemon=True)
        self._worker.start()
        self._translation_worker = threading.Thread(
            target=self._translation_worker_loop,
            name="translation-worker",
            daemon=True,
        )
        self._translation_worker.start()

    @property
    def active(self) -> bool:
        return self._segmenter is not None

    def configure(self, changes: dict[str, object]) -> None:
        if self.active:
            self._emit_issue(
                "error",
                source="protocol",
                code="configuration_while_running",
                message="Stop the active session before changing engine configuration",
                recoverable=True,
            )
            return
        self.settings = self.settings.updated(changes)
        self.engine.configure(self.settings)
        self._engine_ready = False
        self._emit_status("configured")

    def start(self, changes: dict[str, object]) -> None:
        if self.active:
            self._emit_issue(
                "warning",
                source="protocol",
                code="already_running",
                message="The transcription session is already running",
                recoverable=True,
            )
            return
        self.settings = self.settings.updated(changes)
        self.engine.configure(self.settings)
        self._engine_ready = False
        self._session_id = self.session_id_factory()
        with self._translation_state_lock:
            self._session_generation += 1
            self._final_segment_revisions.clear()
        self._emit_status("loading")
        try:
            # Lazy means the heavy model is not imported or initialized until a
            # session is explicitly started. Start does wait for readiness so a
            # capture client never has to send audio into an unavailable engine.
            self.engine.prepare()
        except Exception:
            self._emit_issue(
                "error",
                source="transcription",
                code="engine_initialization_failed",
                message="Could not initialize the transcription engine.",
                recoverable=True,
            )
            self._emit_status("unavailable")
            self._session_id = None
            return
        self._engine_ready = True
        self._prepare_diarization()
        self._prepare_translation()
        self._translation_backpressure_warning_emitted = False
        self._session_overloaded = False
        self._final_inference_failed = False
        self._segmenter = UtteranceSegmenter(self._session_id, self.segmentation_config)
        self._last_end_ms.clear()
        self._emit_status("ready")

    def audio(self, command: AudioCommand) -> None:
        if self._segmenter is None:
            self._emit_issue(
                "warning",
                source="capture",
                code="audio_before_start",
                message="Audio was ignored because no transcription session is running",
                recoverable=True,
            )
            return
        if self._session_overloaded:
            return
        previous_end_ms = self._last_end_ms.get(command.track)
        if previous_end_ms is not None and command.start_ms - previous_end_ms >= 1_000:
            self._emit_issue(
                "warning",
                source="capture",
                code="audio_gap",
                message=f"A {command.start_ms - previous_end_ms} ms gap was detected on the {command.track} track",
                recoverable=True,
            )
        try:
            jobs = self._segmenter.process(
                track=command.track,
                start_ms=command.start_ms,
                end_ms=command.end_ms,
                pcm_s16le=command.pcm_s16le,
            )
        except SegmentationError as exc:
            self._emit_issue(
                "error",
                source="capture",
                code="non_monotonic_audio",
                message=str(exc),
                recoverable=True,
            )
            return
        self._last_end_ms[command.track] = command.end_ms
        self._enqueue(jobs)

    def flush(self) -> None:
        if self._segmenter is None:
            self._emit_issue(
                "warning",
                source="protocol",
                code="flush_without_session",
                message="There is no active transcription session to flush",
                recoverable=True,
            )
            return
        if not self._session_overloaded:
            self._enqueue(self._segmenter.flush())
        self.queue.join()
        self._translation_queue.join()
        self._emit_status("flushed")

    def stop(self) -> None:
        if self._segmenter is None:
            self.event_sink({"type": "session_stopped", "session_id": None, "reason": "already_stopped"})
            return
        session_id = self._session_id
        if not self._session_overloaded:
            self._enqueue(self._segmenter.flush())
        self.queue.join()
        self._translation_queue.join()
        if self._session_overloaded:
            stop_reason = "inference_backpressure"
        elif self._final_inference_failed:
            stop_reason = "final_inference_failed"
        else:
            stop_reason = "stopped"
        self._segmenter = None
        self._session_id = None
        self._last_end_ms.clear()
        self._session_overloaded = False
        self._final_inference_failed = False
        self._diarization_available = False
        self._translation_available = False
        self._diarizer.reset(None)
        with self._translation_state_lock:
            self._final_segment_revisions.clear()
        self.event_sink({"type": "session_stopped", "session_id": session_id, "reason": stop_reason})

    def shutdown(self) -> None:
        if self._shutdown:
            return
        if self.active:
            self.stop()
        self.queue.close()
        self._worker.join()
        self._translation_queue.join()
        self._translation_queue.put(None)
        self._translation_worker.join()
        self.engine.close()
        self._diarizer.close()
        self._translator.close()
        self._shutdown = True
        self._emit_status("shutdown")

    def _enqueue(self, jobs: Iterable[InferenceJob]) -> None:
        if self._session_overloaded:
            return
        for job in jobs:
            try:
                self.queue.put(job)
            except InferenceBackpressureError:
                self._mark_inference_overloaded()
                return

    def _mark_inference_overloaded(self) -> None:
        if self._session_overloaded:
            return
        self._session_overloaded = True
        self._emit_issue(
            "error",
            source="transcription",
            code="inference_backpressure",
            message="Transcription stopped because the local inference audio buffer reached its configured limit",
            recoverable=False,
        )

    def _worker_loop(self) -> None:
        while True:
            job = self.queue.get()
            if job is None:
                return
            try:
                if not self._engine_ready:
                    self._emit_status("loading")
                    self.engine.prepare()
                    self._engine_ready = True
                    self._emit_status("ready")
                result = self.engine.transcribe(job, self.settings.language)
                speaker_id = self._speaker_for(job)
                translation_source = self._translation_source_for(job, result)
                segment = SegmentPayload(
                    id=job.segment_id,
                    revision=job.revision,
                    start_ms=job.start_ms,
                    end_ms=job.end_ms,
                    track=job.track,
                    text=result.text,
                    partial=job.partial,
                    final=job.final,
                    language=result.language,
                    speaker_id=speaker_id,
                    translated_text=None,
                    translated_language=None,
                )
                event_type = "final_segment" if job.final else "partial_transcript"
                self.event_sink(segment_event(event_type, job.session_id, segment))
                if job.final:
                    with self._translation_state_lock:
                        self._final_segment_revisions[(job.session_id, job.segment_id)] = job.revision
                if translation_source is not None:
                    self._enqueue_translation(job, translation_source)
            except Exception:  # Keep one inference failure from killing the sidecar.
                self._engine_ready = False
                if job.final:
                    self._final_inference_failed = True
                self._emit_issue(
                    "error",
                    source="transcription",
                    code="inference_failed",
                    message="Transcription failed for a local segment.",
                    recoverable=True,
                    segment_id=job.segment_id,
                )
            finally:
                self.queue.task_done(job)

    def _translation_worker_loop(self) -> None:
        while True:
            job = self._translation_queue.get()
            if job is None:
                self._translation_queue.task_done()
                return
            try:
                if not self._translation_job_is_current(job) or not self._translation_available:
                    continue
                translated_text = self._translator.translate(job.text)
                if (
                    not isinstance(translated_text, str)
                    or not translated_text.strip()
                    or len(translated_text) > MAX_SEGMENT_TEXT_CHARS
                    or "\x00" in translated_text
                ):
                    raise ValueError("The translated text is invalid")
                if not self._translation_job_is_current(job):
                    continue
                self.event_sink(
                    segment_translation_event(
                        job.session_id,
                        job.segment_id,
                        job.segment_revision,
                        translated_text,
                        translated_language=TRANSLATED_LANGUAGE,
                    )
                )
            except Exception:
                self._emit_translation_unavailable()
            finally:
                self._translation_queue.task_done()

    def _prepare_diarization(self) -> None:
        self._diarization_warning_emitted = False
        self._diarization_available = False
        key = (self.settings.diarization, self.settings.diarization_model)
        try:
            if self._diarizer_key != key:
                self._diarizer.close()
                self._diarizer = self.diarizer_factory(self.settings)
                self._diarizer_key = key
            self._diarizer.reset(self._session_id)
            if self.settings.diarization != "online":
                return
            self._emit_model_progress(ModelLoadProgress(phase="preparing_speakers"))
            self._diarizer.prepare()
            self._diarization_available = True
        except Exception:
            self._emit_diarization_unavailable()

    def _speaker_for(self, job: InferenceJob) -> str | None:
        if (
            self.settings.diarization != "online"
            or not self._diarization_available
            or job.track != "system"
        ):
            return None
        try:
            return self._diarizer.assign(job)
        except Exception:
            self._emit_diarization_unavailable()
            return None

    def _emit_diarization_unavailable(self) -> None:
        self._diarization_available = False
        if self._diarization_warning_emitted:
            return
        self._diarization_warning_emitted = True
        self._emit_issue(
            "warning",
            source="transcription",
            code="diarization_unavailable",
            message="Anonymous speaker labels are unavailable for this session; transcription will continue",
            recoverable=True,
        )

    def _prepare_translation(self) -> None:
        self._translation_warning_emitted = False
        self._translation_available = False
        key = (self.settings.translation, self.settings.translation_model)
        if self.settings.translation != "en_to_pt_br":
            translator = self._translator
            self._translator = NoOpTranslator()
            self._translator_key = None
            try:
                translator.close()
            except Exception:
                # Translation is already disabled and detached. A cleanup
                # failure must not prevent the original transcript session
                # from starting or surface as an availability warning.
                pass
            return
        try:
            if self._translator_key != key:
                self._translator.close()
                self._translator = self.translator_factory(self.settings)
                progress_setter = getattr(self._translator, "set_progress_sink", None)
                if callable(progress_setter):
                    progress_setter(self._emit_translation_progress)
                self._translator_key = key
            self._translator.prepare()
            self._translation_available = True
        except Exception:
            self._emit_translation_unavailable()

    def _translation_source_for(self, job: InferenceJob, result: object) -> str | None:
        if (
            not job.final
            or self.settings.translation != "en_to_pt_br"
            or not self._translation_available
        ):
            return None
        language = getattr(result, "language", None)
        probability = getattr(result, "language_probability", None)
        if not self._translation_is_eligible(language, probability):
            return None
        text = getattr(result, "text", None)
        # Silence and non-speech can legitimately produce an empty finalized
        # ASR segment. It has nothing to translate and must not disable an
        # otherwise healthy translator for the rest of a long meeting.
        if not isinstance(text, str) or not text.strip():
            return None
        return text

    def _enqueue_translation(self, job: InferenceJob, text: str) -> None:
        with self._translation_state_lock:
            session_generation = self._session_generation
        translation_job = _TranslationJob(
            session_generation=session_generation,
            session_id=job.session_id,
            segment_id=job.segment_id,
            segment_revision=job.revision,
            text=text,
        )
        try:
            self._translation_queue.put_nowait(translation_job)
        except Full:
            self._emit_translation_backpressure(job.segment_id)

    def _translation_job_is_current(self, job: _TranslationJob) -> bool:
        with self._translation_state_lock:
            return (
                job.session_generation == self._session_generation
                and job.session_id == self._session_id
                and self._final_segment_revisions.get((job.session_id, job.segment_id))
                == job.segment_revision
            )

    def _emit_translation_backpressure(self, segment_id: str) -> None:
        if self._translation_backpressure_warning_emitted:
            return
        self._translation_backpressure_warning_emitted = True
        self._emit_issue(
            "warning",
            source="transcription",
            code="translation_backpressure",
            message=(
                "Brazilian Portuguese translation is falling behind; original transcription "
                "will continue and some translations may be unavailable"
            ),
            recoverable=True,
            segment_id=segment_id,
        )

    def _translation_is_eligible(self, language: str | None, probability: float | None) -> bool:
        if self.settings.language == "en":
            return True
        try:
            english_only = get_model_manifest().asr_model(self.settings.model).language_mode == "english_only"
        except Exception:
            english_only = False
        if english_only:
            return True
        if self.settings.language not in {None, "auto"}:
            return False
        return is_auto_detected_english(language, probability)

    def _emit_translation_unavailable(self) -> None:
        self._translation_available = False
        if self._translation_warning_emitted:
            return
        self._translation_warning_emitted = True
        self._emit_issue(
            "warning",
            source="transcription",
            code="translation_unavailable",
            message=(
                "Brazilian Portuguese translation is unavailable for this meeting; "
                "original transcription will continue"
            ),
            recoverable=True,
        )

    def _emit_translation_progress(self, phase: str) -> None:
        self._emit_model_progress(ModelLoadProgress(phase=phase))

    def _emit_status(self, status: str) -> None:
        self.event_sink(
            {
                "type": "engine_status",
                "status": status,
                "session_id": self._session_id,
                "model": self.settings.model,
                "language": self.settings.language,
                "device": self.settings.device,
                "compute": self.settings.compute,
            }
        )

    def _emit_model_progress(self, progress: ModelLoadProgress) -> None:
        self.event_sink(
            {
                "type": "model_progress",
                "phase": progress.phase,
                "session_id": self._session_id,
            }
        )

    def _emit_issue(
        self,
        kind: str,
        *,
        source: str,
        code: str,
        message: str,
        recoverable: bool,
        segment_id: str | None = None,
    ) -> None:
        self.event_sink(
            issue_event(
                kind,  # type: ignore[arg-type]
                source=source,  # type: ignore[arg-type]
                code=code,
                message=message,
                recoverable=recoverable,
                segment_id=segment_id,
            )
        )


class JsonlApplication:
    def __init__(
        self,
        engine: TranscriptionEngine,
        *,
        segmentation_config: SegmentationConfig | None = None,
        session_id_factory: Callable[[], str] | None = None,
        max_inference_pcm_bytes: int = DEFAULT_MAX_BUFFERED_PCM_BYTES,
        max_pending_translations: int = DEFAULT_MAX_PENDING_TRANSLATIONS,
        diarizer_factory: DiarizerFactory | None = None,
        translator_factory: TranslatorFactory | None = None,
    ) -> None:
        self.engine = engine
        self.segmentation_config = segmentation_config
        self.session_id_factory = session_id_factory
        self.max_inference_pcm_bytes = max_inference_pcm_bytes
        self.max_pending_translations = max_pending_translations
        self.diarizer_factory = diarizer_factory
        self.translator_factory = translator_factory

    def run(self, input_stream: TextIO, output_stream: TextIO) -> None:
        output_lock = threading.Lock()

        def emit(event: dict[str, object]) -> None:
            line = serialize_event(event)
            with output_lock:
                output_stream.write(line + "\n")
                output_stream.flush()

        service = TranscriptionService(
            self.engine,
            emit,
            segmentation_config=self.segmentation_config,
            session_id_factory=self.session_id_factory,
            max_inference_pcm_bytes=self.max_inference_pcm_bytes,
            max_pending_translations=self.max_pending_translations,
            diarizer_factory=self.diarizer_factory,
            translator_factory=self.translator_factory,
        )
        try:
            for line in input_stream:
                if not line.strip():
                    continue
                try:
                    command = parse_command(line)
                except ProtocolError as exc:
                    emit(
                        issue_event(
                            "error",
                            source="protocol",
                            code=exc.code,
                            message=str(exc),
                            recoverable=True,
                        )
                    )
                    continue
                if isinstance(command, ConfigureCommand):
                    service.configure(command.changes)
                elif isinstance(command, StartCommand):
                    service.start(command.changes)
                elif isinstance(command, AudioCommand):
                    service.audio(command)
                elif isinstance(command, FlushCommand):
                    service.flush()
                elif isinstance(command, StopCommand):
                    service.stop()
                elif isinstance(command, ShutdownCommand):
                    service.shutdown()
                    return
        finally:
            service.shutdown()


def _default_diarizer_factory(settings: EngineSettings) -> SpeakerDiarizer:
    if settings.diarization == "online":
        return OnlineSpeakerDiarizer(model_path=settings.diarization_model)
    return NoOpSpeakerDiarizer()


def _default_translator_factory(settings: EngineSettings) -> TranslatorProtocol:
    if settings.translation == "en_to_pt_br":
        return LocalCTranslate2Translator(model_root=settings.translation_model)
    return NoOpTranslator()
