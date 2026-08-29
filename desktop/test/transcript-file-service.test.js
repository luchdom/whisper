import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TranscriptFileError,
  buildTranscriptFileName,
  createTranscriptFileService,
  ensureMarkdownExtension,
  validateFinalMarkdown
} from "../main/transcript-file-service.js";

const FIXED_DATE = new Date("2026-08-28T13:14:15.678Z");
const FIRST_NAME = "meeting-transcript-2026-08-28-13-14-15.md";

test("transcript helpers produce English Markdown names and reject invalid final content", () => {
  assert.equal(buildTranscriptFileName(FIXED_DATE), FIRST_NAME);
  assert.equal(
    buildTranscriptFileName(FIXED_DATE, 2),
    "meeting-transcript-2026-08-28-13-14-15-2.md"
  );
  assert.equal(ensureMarkdownExtension("C:\\Meetings\\notes"), "C:\\Meetings\\notes.md");
  assert.equal(ensureMarkdownExtension("C:\\Meetings\\notes.MD"), "C:\\Meetings\\notes.MD");
  assert.equal(validateFinalMarkdown("# Meeting\n\nFinal words."), "# Meeting\n\nFinal words.");
  assert.throws(() => validateFinalMarkdown("  "), errorWithCode("invalid_transcript"));
  assert.throws(() => validateFinalMarkdown("éé", 3), errorWithCode("transcript_too_large"));
});

test("autosave creates a collision-safe file and refreshes that same path through rename", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  await fs.writeFile(path.join(directory, FIRST_NAME), "existing", "utf8");

  const renameCalls = [];
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      renameCalls.push({ source, destination });
      return fs.rename(source, destination);
    }
  };
  const service = createTranscriptFileService({ fileSystem, now: () => FIXED_DATE });

  const created = await service.autoSave({ directory, markdown: "# Meeting\n\nFirst final." });
  const currentPath = service.getCurrentAutoSavePath();
  assert.deepEqual(created, {
    created: true,
    fileName: "meeting-transcript-2026-08-28-13-14-15-2.md"
  });
  assert.equal(currentPath, path.join(directory, created.fileName));
  assert.equal("filePath" in created, false);

  const refreshed = await service.autoSave({
    directory: path.join(directory, "ignored-after-create"),
    markdown: "# Meeting\n\nFirst final.\n\nSecond final."
  });

  assert.deepEqual(refreshed, { created: false, fileName: created.fileName });
  assert.equal(service.getCurrentAutoSavePath(), currentPath);
  assert.equal(await fs.readFile(currentPath, "utf8"), "# Meeting\n\nFirst final.\n\nSecond final.");
  assert.equal(renameCalls.length, 1);
  assert.equal(renameCalls[0].destination, currentPath);
  assert.deepEqual((await fs.readdir(directory)).sort(), [FIRST_NAME, created.fileName].sort());
});

test("autosave path changes only after an explicit reset and a successful new create", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const service = createTranscriptFileService({ now: () => FIXED_DATE });

  await service.createAutoSave({ directory, markdown: "# First meeting\n\nFinal." });
  const firstPath = service.getCurrentAutoSavePath();
  await assert.rejects(
    service.createAutoSave({ directory, markdown: "# Unexpected second file\n\nFinal." }),
    errorWithCode("autosave_already_initialized")
  );
  assert.equal(service.getCurrentAutoSavePath(), firstPath);

  service.resetCurrentAutoSavePath();
  assert.equal(service.getCurrentAutoSavePath(), null);
  await service.createAutoSave({ directory, markdown: "# Second meeting\n\nFinal." });
  assert.notEqual(service.getCurrentAutoSavePath(), firstPath);
  assert.equal(path.basename(service.getCurrentAutoSavePath()), "meeting-transcript-2026-08-28-13-14-15-2.md");
});

test("a missing transcript folder yields a public error and does not claim an autosave path", async (t) => {
  const root = await makeTemporaryDirectory(t);
  const missingDirectory = path.join(root, "missing");
  const service = createTranscriptFileService({ now: () => FIXED_DATE });

  await assert.rejects(
    service.autoSave({ directory: missingDirectory, markdown: "# Meeting\n\nFinal." }),
    (error) => {
      assert.equal(error instanceof TranscriptFileError, true);
      assert.equal(error.code, "transcript_directory_missing");
      assert.match(error.publicMessage, /does not exist/i);
      return true;
    }
  );
  assert.equal(service.getCurrentAutoSavePath(), null);
});

test("manual save appends Markdown extension and does not mutate autosave ownership", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const service = createTranscriptFileService({ now: () => FIXED_DATE });
  await service.createAutoSave({ directory, markdown: "# Automatic\n\nFinal." });
  const autoSavePath = service.getCurrentAutoSavePath();

  const result = await service.saveManual({
    filePath: path.join(directory, "chosen-name"),
    markdown: "# Manual\n\nOnly finalized text."
  });

  assert.deepEqual(result, { fileName: "chosen-name.md" });
  assert.equal(
    await fs.readFile(path.join(directory, "chosen-name.md"), "utf8"),
    "# Manual\n\nOnly finalized text."
  );
  assert.equal(service.getCurrentAutoSavePath(), autoSavePath);
});

test("transcript service enforces its configured UTF-8 byte bound before writing", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const service = createTranscriptFileService({ now: () => FIXED_DATE, maxBytes: 10 });

  await assert.rejects(
    service.autoSave({ directory, markdown: "# 123456789" }),
    errorWithCode("transcript_too_large")
  );
  assert.deepEqual(await fs.readdir(directory), []);
});

function errorWithCode(code) {
  return (error) => error instanceof TranscriptFileError && error.code === code;
}

async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-transcript-files-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
