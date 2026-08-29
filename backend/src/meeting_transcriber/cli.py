"""Console entry point for the meeting transcription sidecar."""

from __future__ import annotations

import argparse
import io
import sys
from typing import TextIO

from .engine import FakeTranscriptionEngine, FasterWhisperEngine
from .service import JsonlApplication


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Local meeting transcription JSONL sidecar")
    parser.add_argument(
        "--engine",
        choices=("faster-whisper", "fake"),
        default="faster-whisper",
        help="Use 'fake' only for deterministic UI smoke testing",
    )
    return parser


def configure_standard_streams_utf8(
    stdin: TextIO | None = None,
    stdout: TextIO | None = None,
) -> None:
    """Make the JSONL wire encoding deterministic, including Windows pipes.

    StringIO and wrapped streams used by embedders may not expose reconfigure;
    those streams are already text streams and are intentionally left alone.
    """

    input_stream = sys.stdin if stdin is None else stdin
    output_stream = sys.stdout if stdout is None else stdout
    _reconfigure_utf8(input_stream, newline=None, write_through=False)
    _reconfigure_utf8(output_stream, newline="\n", write_through=True)


def _reconfigure_utf8(stream: TextIO, *, newline: str | None, write_through: bool) -> None:
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:
        return
    try:
        reconfigure(
            encoding="utf-8",
            errors="strict",
            newline=newline,
            write_through=write_through,
        )
    except (AttributeError, ValueError, io.UnsupportedOperation):
        # Some host-provided text streams expose a restricted reconfigure.
        # The application can still operate on their existing text boundary.
        return


def main(argv: list[str] | None = None) -> int:
    configure_standard_streams_utf8()
    args = build_parser().parse_args(argv)
    engine = FakeTranscriptionEngine() if args.engine == "fake" else FasterWhisperEngine()
    JsonlApplication(engine).run(sys.stdin, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
