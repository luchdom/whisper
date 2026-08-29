import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("source bootstraps require CPython 3.12 and never install system prerequisites", async () => {
  const [powershell, shell] = await Promise.all([
    readFile(new URL("scripts/bootstrap.ps1", root), "utf8"),
    readFile(new URL("scripts/bootstrap.sh", root), "utf8")
  ]);

  for (const script of [powershell, shell]) {
    assert.match(script, /sys\.implementation\.name\s*==\s*["']cpython["']/);
    assert.match(script, /sys\.version_info\[:2\]\s*==\s*\(3,\s*12\)/);
    assert.match(script, /--frozen-lockfile/);
    assert.doesNotMatch(script, /\b(?:winget|brew\s+install|sudo|Invoke-Expression)\b/i);
    assert.doesNotMatch(script, /curl[^\n|]*\|/i);
  }
});

test("the Python dependency contract pins every direct native runtime dependency", async () => {
  const constraints = await readFile(new URL("backend/constraints.txt", root), "utf8");

  assert.match(constraints, /^faster-whisper==1\.2\.1$/m);
  assert.match(constraints, /^huggingface-hub==1\.29\.0$/m);
  assert.match(constraints, /^sherpa-onnx==1\.13\.6$/m);
});
