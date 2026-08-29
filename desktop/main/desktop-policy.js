import path from "node:path";
import {
  ALLOWED_CLOSE_BEHAVIORS,
  ALLOWED_LANGUAGES,
  ALLOWED_TRANSLATION_MODES
} from "./settings-store.js";

const START_KEYS = new Set(["model", "language", "diarization", "translation"]);
const SETTINGS_PATCH_KEYS = new Set([
  "model",
  "language",
  "diarization",
  "translation",
  "autoSave",
  "closeBehavior",
  "minimizeToTray",
  "launchAtStartup"
]);
const LANGUAGE_SET = new Set(ALLOWED_LANGUAGES);
const TRANSLATION_SET = new Set(ALLOWED_TRANSLATION_MODES);
const CLOSE_BEHAVIOR_SET = new Set(ALLOWED_CLOSE_BEHAVIORS);

export function createBackendStartOptions(value, { userDataPath, catalog } = {}) {
  assertCatalog(catalog);
  if (!isRecord(value)) throw new TypeError("Transcription settings are invalid.");
  if (Object.keys(value).some((key) => !START_KEYS.has(key))) {
    throw new TypeError("Transcription settings contain an unsupported field.");
  }
  const model = catalog.getModel(value.model);
  if (!model) throw new TypeError("The selected model is not supported.");
  if (!LANGUAGE_SET.has(value.language)) throw new TypeError("The selected language is not supported.");
  if (typeof value.diarization !== "boolean") {
    throw new TypeError("The speaker detection setting is invalid.");
  }
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new TypeError("The local application data path is invalid.");
  }
  if (!TRANSLATION_SET.has(value.translation) || !catalog.isTranslationAvailable(value.translation)) {
    throw new TypeError("The selected translation mode is unavailable in this build.");
  }

  const modelsRoot = path.join(userDataPath, "models");

  return Object.freeze({
    model: value.model,
    language: model.languageMode === "english_only" ? "en" : value.language,
    device: "cpu",
    compute: "int8",
    download_root: path.join(modelsRoot, "asr"),
    diarization: value.diarization ? "online" : "off",
    diarization_model: path.join(modelsRoot, catalog.getSpeakerFileName()),
    translation: value.translation,
    translation_model: value.translation === "en_to_pt_br"
      ? path.join(modelsRoot, "translation")
      : null
  });
}

export function validateRendererSettingsPatch(value, { catalog } = {}) {
  assertCatalog(catalog);
  if (!isRecord(value)) throw new TypeError("Settings update must be an object.");
  if (Object.keys(value).some((key) => !SETTINGS_PATCH_KEYS.has(key))) {
    throw new TypeError("Settings update contains an unsupported field.");
  }

  const patch = {};
  if ("model" in value) {
    if (!catalog.hasModel(value.model)) throw new TypeError("The selected model is not supported.");
    patch.model = value.model;
  }
  if ("language" in value) {
    if (!LANGUAGE_SET.has(value.language)) throw new TypeError("The selected language is not supported.");
    patch.language = value.language;
  }
  if ("diarization" in value) {
    if (typeof value.diarization !== "boolean") throw new TypeError("The speaker detection setting is invalid.");
    patch.diarization = value.diarization;
  }
  if ("translation" in value) {
    if (!TRANSLATION_SET.has(value.translation) || !catalog.isTranslationAvailable(value.translation)) {
      throw new TypeError("The selected translation mode is unavailable in this build.");
    }
    patch.translation = value.translation;
  }
  if ("autoSave" in value) {
    if (typeof value.autoSave !== "boolean") throw new TypeError("The automatic save setting is invalid.");
    patch.autoSave = value.autoSave;
  }
  if ("closeBehavior" in value) {
    if (!CLOSE_BEHAVIOR_SET.has(value.closeBehavior)) {
      throw new TypeError("The window close behavior is invalid.");
    }
    patch.closeBehavior = value.closeBehavior;
  }
  if ("minimizeToTray" in value) {
    if (typeof value.minimizeToTray !== "boolean") {
      throw new TypeError("The minimize-to-tray setting is invalid.");
    }
    patch.minimizeToTray = value.minimizeToTray;
  }
  if ("launchAtStartup" in value) {
    if (typeof value.launchAtStartup !== "boolean") {
      throw new TypeError("The launch-at-startup setting is invalid.");
    }
    patch.launchAtStartup = value.launchAtStartup;
  }
  return patch;
}

function assertCatalog(catalog) {
  if (!catalog
    || typeof catalog.hasModel !== "function"
    || typeof catalog.getModel !== "function"
    || typeof catalog.isTranslationAvailable !== "function"
    || typeof catalog.getSpeakerFileName !== "function") {
    throw new TypeError("A validated model catalog is required.");
  }
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
