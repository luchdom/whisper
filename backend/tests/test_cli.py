from __future__ import annotations

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

from meeting_transcriber.cli import configure_standard_streams_utf8


BACKEND_ROOT = Path(__file__).resolve().parents[1]


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


if __name__ == "__main__":
    unittest.main()
