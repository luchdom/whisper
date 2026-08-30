from __future__ import annotations

import io
import json
import os
from pathlib import Path
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from meeting_transcriber.cli import (
    SETUP_COMPONENTS,
    build_setup_probe,
    configure_standard_streams_utf8,
)


BACKEND_ROOT = Path(__file__).resolve().parents[1]
EXPECTED_SETUP_COMPONENTS = {
    "meeting_transcriber",
    "faster_whisper",
    "faster_whisper.utils",
    "huggingface_hub",
    "numpy",
    "sherpa_onnx",
    "ctranslate2",
    "ctranslate2.converters",
    "sentencepiece",
}


class CliTests(unittest.TestCase):
    def test_stream_configuration_tolerates_in_memory_text_streams(self) -> None:
        configure_standard_streams_utf8(io.StringIO(), io.StringIO())

    def test_utf8_survives_real_cli_pipe_when_process_default_is_cp1252(self) -> None:
        phrase = "transcrição reunião"
        input_bytes = (
            # Keep input ASCII-escaped so this specifically proves that a
            # proper in-process Unicode string is encoded as UTF-8 on output,
            # rather than accidentally reversing an input mojibake round trip.
            json.dumps({"type": phrase}, ensure_ascii=True)
            + "\n"
            + json.dumps({"type": "shutdown"})
            + "\n"
        ).encode("ascii")
        environment = os.environ.copy()
        existing_pythonpath = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = str(BACKEND_ROOT / "src") + (
            os.pathsep + existing_pythonpath if existing_pythonpath else ""
        )
        # Reproduce the Windows pipe failure deterministically on every host.
        # The CLI's explicit reconfigure must override this inherited default.
        environment["PYTHONUTF8"] = "0"
        environment["PYTHONIOENCODING"] = "cp1252:strict"

        completed = subprocess.run(
            [sys.executable, "-m", "meeting_transcriber", "--engine", "fake"],
            input=input_bytes,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=BACKEND_ROOT,
            env=environment,
            check=False,
            timeout=10,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
        decoded_output = completed.stdout.decode("utf-8", errors="strict")
        events = [json.loads(line) for line in decoded_output.splitlines()]
        self.assertIn(phrase, events[0]["message"])
        self.assertEqual(events[0]["code"], "unknown_command")
        self.assertEqual(events[-1]["status"], "shutdown")
        self.assertNotIn(phrase.encode("utf-8"), completed.stderr)

    def test_setup_probe_reports_the_embedded_runtime_without_starting_jsonl(self) -> None:
        environment = os.environ.copy()
        existing_pythonpath = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = str(BACKEND_ROOT / "src") + (
            os.pathsep + existing_pythonpath if existing_pythonpath else ""
        )

        completed = subprocess.run(
            [sys.executable, "-m", "meeting_transcriber", "--setup-probe"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=BACKEND_ROOT,
            env=environment,
            check=False,
            timeout=20,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))
        output = completed.stdout.decode("utf-8", errors="strict").strip()
        sentinel = "__MEETING_TRANSCRIBER_SETUP_V1__"
        self.assertTrue(output.startswith(sentinel))
        payload = json.loads(output[len(sentinel) :])
        self.assertEqual(payload["version"][:2], [3, 12])
        self.assertEqual(payload["implementation"], "cpython")
        self.assertEqual(set(payload["components"]), EXPECTED_SETUP_COMPONENTS)
        self.assertEqual(payload["components"], dict.fromkeys(EXPECTED_SETUP_COMPONENTS, "ready"))

    def test_setup_probe_marks_missing_modules_and_missing_lazy_symbols(self) -> None:
        modules = {
            name: SimpleNamespace(**{symbol: object() for symbol in required_symbols})
            for name, required_symbols in SETUP_COMPONENTS.items()
        }
        del modules["sentencepiece"].SentencePieceProcessor

        with (
            patch(
                "meeting_transcriber.cli.importlib.util.find_spec",
                side_effect=lambda name: None if name == "huggingface_hub" else object(),
            ),
            patch(
                "meeting_transcriber.cli.importlib.import_module",
                side_effect=lambda name: modules[name],
            ),
        ):
            payload = build_setup_probe()

        components = payload["components"]
        self.assertEqual(set(components), EXPECTED_SETUP_COMPONENTS)
        self.assertEqual(components["huggingface_hub"], "missing")
        self.assertEqual(components["sentencepiece"], "broken")
        self.assertTrue(
            all(
                status == "ready"
                for name, status in components.items()
                if name not in {"huggingface_hub", "sentencepiece"}
            )
        )


if __name__ == "__main__":
    unittest.main()
