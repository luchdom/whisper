import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ALLOWED_LANGUAGES = Object.freeze(["auto", "en", "pt"]);
export const ALLOWED_TRANSLATION_MODES = Object.freeze(["off", "en_to_pt_br"]);
export const ALLOWED_CLOSE_BEHAVIORS = Object.freeze(["quit", "tray"]);

export const DEFAULT_SETTINGS = Object.freeze({
  model: "small",
  language: "auto",
  diarization: true,
  translation: "off",
  transcriptDirectory: null,
  autoSave: false,
  closeBehavior: "quit",
  minimizeToTray: false
});

const LANGUAGE_SET = new Set(ALLOWED_LANGUAGES);
const TRANSLATION_SET = new Set(ALLOWED_TRANSLATION_MODES);
const CLOSE_BEHAVIOR_SET = new Set(ALLOWED_CLOSE_BEHAVIORS);
const MAX_DIRECTORY_LENGTH = 4_096;

export function sanitizeSettings(value, { catalog } = {}) {
  assertCatalog(catalog);
  const input = isRecord(value) ? value : {};
  const model = catalog.hasModel(input.model) ? input.model : catalog.defaultModelId;
  const requestedLanguage = LANGUAGE_SET.has(input.language)
    ? input.language
    : DEFAULT_SETTINGS.language;
  const transcriptDirectory = sanitizeDirectory(input.transcriptDirectory);
  const requestedTranslation = TRANSLATION_SET.has(input.translation)
    ? input.translation
    : DEFAULT_SETTINGS.translation;

  return {
    model,
    // Preserve the user's multilingual preference while an English-only model
    // is selected. Start policy applies the effective language from metadata.
    language: requestedLanguage,
    diarization: typeof input.diarization === "boolean"
      ? input.diarization
      : DEFAULT_SETTINGS.diarization,
    translation: catalog.isTranslationAvailable(requestedTranslation)
      ? requestedTranslation
      : DEFAULT_SETTINGS.translation,
    transcriptDirectory,
    autoSave: transcriptDirectory !== null && (typeof input.autoSave === "boolean"
      ? input.autoSave
      : DEFAULT_SETTINGS.autoSave),
    closeBehavior: CLOSE_BEHAVIOR_SET.has(input.closeBehavior)
      ? input.closeBehavior
      : DEFAULT_SETTINGS.closeBehavior,
    minimizeToTray: typeof input.minimizeToTray === "boolean"
      ? input.minimizeToTray
      : DEFAULT_SETTINGS.minimizeToTray
  };
}

export function createSettingsStore({
  userDataPath,
  fileName = "settings.json",
  fileSystem = fs,
  catalog
} = {}) {
  assertCatalog(catalog);
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new TypeError("userDataPath must be an absolute path.");
  }
  if (typeof fileName !== "string" || fileName.length === 0 || path.basename(fileName) !== fileName) {
    throw new TypeError("fileName must be a plain file name.");
  }

  const filePath = path.join(userDataPath, fileName);

  async function load() {
    let serialized;
    try {
      serialized = await fileSystem.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { ...DEFAULT_SETTINGS };
      throw error;
    }

    try {
      return sanitizeSettings(JSON.parse(serialized), { catalog });
    } catch (error) {
      if (error instanceof SyntaxError) return { ...DEFAULT_SETTINGS };
      throw error;
    }
  }

  async function save(value) {
    const settings = sanitizeSettings(value, { catalog });
    await fileSystem.mkdir(userDataPath, { recursive: true });

    const temporaryPath = path.join(
      userDataPath,
      `.${fileName}.${process.pid}.${randomUUID()}.tmp`
    );

    try {
      await fileSystem.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await fileSystem.rename(temporaryPath, filePath);
    } finally {
      await fileSystem.unlink(temporaryPath).catch(() => {});
    }

    return settings;
  }

  async function update(patch) {
    const current = await load();
    const next = isRecord(patch) ? { ...current, ...patch } : current;
    return save(next);
  }

  return Object.freeze({ filePath, load, save, update });
}

function assertCatalog(catalog) {
  if (!catalog
    || typeof catalog.defaultModelId !== "string"
    || typeof catalog.hasModel !== "function"
    || typeof catalog.isTranslationAvailable !== "function"
    || !catalog.hasModel(catalog.defaultModelId)) {
    throw new TypeError("A validated model catalog is required.");
  }
}

function sanitizeDirectory(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_DIRECTORY_LENGTH) {
    return null;
  }
  if (value.includes("\0") || !path.isAbsolute(value)) return null;
  return value;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
