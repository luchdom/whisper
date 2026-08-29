import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const MAX_TRANSCRIPT_BYTES = 10_000_000;
const MAX_COLLISION_ATTEMPTS = 10_000;

export class TranscriptFileError extends Error {
  constructor(code, publicMessage, options = {}) {
    super(publicMessage, options);
    this.name = "TranscriptFileError";
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function validateFinalMarkdown(markdown, maxBytes = MAX_TRANSCRIPT_BYTES) {
  if (typeof markdown !== "string" || markdown.trim().length === 0 || markdown.includes("\0")) {
    throw new TranscriptFileError(
      "invalid_transcript",
      "The finalized transcript content is invalid."
    );
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive safe integer.");
  }
  if (Buffer.byteLength(markdown, "utf8") > maxBytes) {
    throw new TranscriptFileError(
      "transcript_too_large",
      "The transcript is too large to save safely."
    );
  }
  return markdown;
}

export function buildTranscriptFileName(date = new Date(), suffix = 1) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError("date must be valid.");
  }
  if (!Number.isSafeInteger(suffix) || suffix < 1) {
    throw new TypeError("suffix must be a positive safe integer.");
  }

  const timestamp = date.toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace("T", "-")
    .replaceAll(":", "-")
    .replace(/Z$/, "");
  const collisionSuffix = suffix === 1 ? "" : `-${suffix}`;
  return `meeting-transcript-${timestamp}${collisionSuffix}.md`;
}

export function ensureMarkdownExtension(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0 || filePath.includes("\0")) {
    throw new TranscriptFileError("invalid_file_path", "The selected save location is invalid.");
  }
  return filePath.toLowerCase().endsWith(".md") ? filePath : `${filePath}.md`;
}

export function createTranscriptFileService({
  fileSystem = fs,
  now = () => new Date(),
  maxBytes = MAX_TRANSCRIPT_BYTES
} = {}) {
  let currentAutoSavePath = null;

  async function createAutoSave({ directory, markdown } = {}) {
    validateFinalMarkdown(markdown, maxBytes);
    if (currentAutoSavePath) {
      throw new TranscriptFileError(
        "autosave_already_initialized",
        "The automatic transcript file for this meeting already exists."
      );
    }
    await assertExistingDirectory(directory, fileSystem);

    const createdPath = await createCollisionSafeFile({
      directory,
      markdown,
      date: now(),
      fileSystem
    });
    currentAutoSavePath = createdPath;
    return Object.freeze({ created: true, fileName: path.basename(createdPath) });
  }

  async function refreshAutoSave(markdown) {
    validateFinalMarkdown(markdown, maxBytes);
    if (!currentAutoSavePath) {
      throw new TranscriptFileError(
        "autosave_not_initialized",
        "The automatic transcript file for this meeting has not been created yet."
      );
    }

    await replaceFileSafely(currentAutoSavePath, markdown, fileSystem);
    return Object.freeze({ created: false, fileName: path.basename(currentAutoSavePath) });
  }

  async function autoSave({ directory, markdown } = {}) {
    return currentAutoSavePath
      ? refreshAutoSave(markdown)
      : createAutoSave({ directory, markdown });
  }

  async function saveManual({ filePath, markdown } = {}) {
    validateFinalMarkdown(markdown, maxBytes);
    const destination = ensureMarkdownExtension(filePath);
    await assertExistingDirectory(path.dirname(destination), fileSystem);
    await replaceFileSafely(destination, markdown, fileSystem);
    return Object.freeze({ fileName: path.basename(destination) });
  }

  function getCurrentAutoSavePath() {
    return currentAutoSavePath;
  }

  function resetCurrentAutoSavePath() {
    currentAutoSavePath = null;
  }

  return Object.freeze({
    autoSave,
    createAutoSave,
    refreshAutoSave,
    saveManual,
    getCurrentAutoSavePath,
    resetCurrentAutoSavePath
  });
}

async function assertExistingDirectory(directory, fileSystem) {
  if (typeof directory !== "string" || directory.length === 0 || !path.isAbsolute(directory)) {
    throw missingDirectoryError();
  }

  try {
    const stats = await fileSystem.stat(directory);
    if (!stats.isDirectory()) throw missingDirectoryError();
  } catch (error) {
    if (error instanceof TranscriptFileError) throw error;
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw missingDirectoryError();
    throw new TranscriptFileError(
      "transcript_directory_unavailable",
      "The transcript folder is unavailable. Choose another folder in Settings.",
      { cause: error }
    );
  }
}

async function createCollisionSafeFile({ directory, markdown, date, fileSystem }) {
  for (let suffix = 1; suffix <= MAX_COLLISION_ATTEMPTS; suffix += 1) {
    const filePath = path.join(directory, buildTranscriptFileName(date, suffix));
    try {
      await fileSystem.writeFile(filePath, markdown, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return filePath;
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw missingDirectoryError();
      throw writeError(error);
    }
  }

  throw new TranscriptFileError(
    "autosave_name_exhausted",
    "A unique name could not be created for the automatic transcript."
  );
}

async function replaceFileSafely(filePath, markdown, fileSystem) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );

  try {
    await fileSystem.writeFile(temporaryPath, markdown, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fileSystem.rename(temporaryPath, filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") throw missingDirectoryError();
    throw writeError(error);
  } finally {
    await fileSystem.unlink(temporaryPath).catch(() => {});
  }
}

function missingDirectoryError() {
  return new TranscriptFileError(
    "transcript_directory_missing",
    "The transcript folder does not exist. Choose another folder in Settings."
  );
}

function writeError(cause) {
  return new TranscriptFileError(
    "transcript_write_failed",
    "The transcript could not be saved. Check the folder and try again.",
    { cause }
  );
}
