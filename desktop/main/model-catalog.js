import fs from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";

const MAX_MANIFEST_BYTES = 1_000_000;
const MAX_DEPTH = 64;
const MAX_CONTAINER_ITEMS = 10_000;
const MAX_STRING_LENGTH = 20_000;
const EXPECTED_ASR_COUNT = 14;
const EXPECTED_TRANSLATION_SOURCE_MEMBER_COUNT = 13;
const TRANSLATION_PLATFORM = "win32-x64";
const TRANSLATION_ARCHIVE_ORIGIN = "https://object.pouta.csc.fi";
const TRANSLATION_CONVERTER_VERSION = "4.8.1";
const TIER_ORDER = Object.freeze(["very_light", "light", "balanced", "high", "very_high"]);
const LANGUAGE_MODES = new Set(["multilingual", "english_only"]);
const ROOT_KEYS = Object.freeze([
  "schema_version",
  "default_asr_model",
  "asr_models",
  "speaker_models",
  "translation_models"
]);
const ASR_KEYS = Object.freeze([
  "id", "label", "tier", "helper", "language_mode", "repository", "revision", "license", "files"
]);
const FILE_KEYS = Object.freeze(["path", "size", "sha256"]);
const SPEAKER_KEYS = Object.freeze([
  "id", "repository", "revision", "release_tag", "license", "url", "file"
]);
const TRANSLATION_KEYS = Object.freeze([
  "id", "mode", "label", "platforms", "upstream", "source", "conversion"
]);

export class ModelCatalogError extends Error {
  constructor(code = "model_catalog_unavailable") {
    super("Model catalog unavailable.");
    this.name = "ModelCatalogError";
    this.code = code;
  }
}

export function parseStrictJson(source) {
  if (typeof source !== "string" || Buffer.byteLength(source, "utf8") > MAX_MANIFEST_BYTES) {
    throw new ModelCatalogError("invalid_catalog_json");
  }
  try {
    return new StrictJsonParser(source).parse();
  } catch (error) {
    if (error instanceof ModelCatalogError) throw error;
    throw new ModelCatalogError("invalid_catalog_json");
  }
}

export function createModelCatalogFromJson(source, {
  platform = process.platform,
  arch = process.arch
} = {}) {
  try {
    return buildCatalog(validateManifest(parseStrictJson(source)), { platform, arch });
  } catch (error) {
    if (error instanceof ModelCatalogError) throw error;
    throw new ModelCatalogError();
  }
}

export async function loadModelCatalog({
  manifestPath,
  fileSystem = fs,
  platform = process.platform,
  arch = process.arch
} = {}) {
  if (typeof manifestPath !== "string" || !path.isAbsolute(manifestPath)) {
    throw new ModelCatalogError();
  }
  try {
    const source = await fileSystem.readFile(manifestPath, "utf8");
    return createModelCatalogFromJson(source, { platform, arch });
  } catch {
    throw new ModelCatalogError();
  }
}

function validateManifest(value) {
  const root = record(value);
  exactKeys(root, ROOT_KEYS);
  if (root.schema_version !== 1) invalid();
  if (root.default_asr_model !== "small") invalid();

  const asrModels = array(root.asr_models, EXPECTED_ASR_COUNT, EXPECTED_ASR_COUNT);
  const speakerModels = array(root.speaker_models, 1, 1);
  const translationModels = array(root.translation_models, 1, 1);
  const allIds = new Set();
  const labels = new Set();
  let previousTier = -1;
  const seenTiers = new Set();

  const validatedAsr = asrModels.map((candidate) => {
    const model = record(candidate);
    exactKeys(model, ASR_KEYS);
    const id = safeId(model.id);
    uniqueCasefold(allIds, id);
    const label = safeText(model.label, 120);
    uniqueCasefold(labels, label);
    const tier = oneOf(model.tier, TIER_ORDER);
    const tierIndex = TIER_ORDER.indexOf(tier);
    if (tierIndex < previousTier) invalid();
    previousTier = tierIndex;
    seenTiers.add(tier);
    const helper = safeText(model.helper, 220);
    const languageMode = oneOf(model.language_mode, LANGUAGE_MODES);
    repository(model.repository);
    revision(model.revision);
    license(model.license);
    const files = validateFiles(model.files);
    return Object.freeze({ id, label, tier, helper, languageMode, files });
  });
  if (seenTiers.size !== TIER_ORDER.length) invalid();
  if (!validatedAsr.some(({ id }) => id === root.default_asr_model)) invalid();

  const speaker = record(speakerModels[0]);
  exactKeys(speaker, SPEAKER_KEYS);
  const speakerId = safeId(speaker.id);
  uniqueCasefold(allIds, speakerId);
  repository(speaker.repository);
  revision(speaker.revision);
  safeToken(speaker.release_tag, 120);
  license(speaker.license);
  httpsUrl(speaker.url);
  const speakerFile = validateFile(speaker.file);

  const translation = record(translationModels[0]);
  exactKeys(translation, TRANSLATION_KEYS);
  const translationId = safeId(translation.id);
  uniqueCasefold(allIds, translationId);
  const translationMode = oneOf(translation.mode, new Set(["en_to_pt_br"]));
  const translationLabel = safeText(translation.label, 120);
  const platforms = validateTranslationPlatforms(translation.platforms);

  const upstream = record(translation.upstream);
  exactKeys(upstream, ["repository", "revision", "license"]);
  repository(upstream.repository);
  revision(upstream.revision);
  license(upstream.license);

  const source = record(translation.source);
  exactKeys(source, ["url", "size", "sha256", "members"]);
  translationArchiveUrl(source.url);
  const sourceSize = byteSize(source.size);
  sha256(source.sha256);
  const members = array(
    source.members,
    EXPECTED_TRANSLATION_SOURCE_MEMBER_COUNT,
    EXPECTED_TRANSLATION_SOURCE_MEMBER_COUNT
  );
  const memberPaths = new Set();
  let hasExtractedMember = false;
  for (const candidate of members) {
    const member = record(candidate);
    exactKeys(member, ["path", "size", "sha256", "extract"]);
    uniqueCasefold(memberPaths, safeRelativePath(member.path));
    byteSize(member.size);
    sha256(member.sha256);
    if (typeof member.extract !== "boolean") invalid();
    hasExtractedMember ||= member.extract;
  }
  if (!hasExtractedMember) invalid();

  const conversion = record(translation.conversion);
  exactKeys(conversion, ["tool", "version", "quantization", "target_token", "files"]);
  if (conversion.tool !== "ctranslate2" || conversion.quantization !== "int8" || conversion.target_token !== ">>pob<<") {
    invalid();
  }
  if (conversion.version !== TRANSLATION_CONVERTER_VERSION) invalid();
  validateFiles(conversion.files);

  return Object.freeze({
    defaultModelId: root.default_asr_model,
    asrModels: Object.freeze(validatedAsr),
    speakerFileName: speakerFile.path,
    translation: Object.freeze({
      id: translationId,
      mode: translationMode,
      label: translationLabel,
      platforms: Object.freeze(platforms),
      downloadBytes: sourceSize
    })
  });
}

function buildCatalog(validated, { platform, arch }) {
  if (!/^(win32|darwin|linux)$/.test(platform) || !/^(x64|arm64)$/.test(arch)) invalid();
  const models = validated.asrModels.map((model) => deepFreeze({
    id: model.id,
    label: model.label,
    tier: model.tier,
    languageMode: model.languageMode,
    downloadBytes: sumFileSizes(model.files),
    helper: model.helper
  }));
  const byId = new Map(models.map((model) => [model.id, model]));
  const translation = deepFreeze({
    mode: validated.translation.mode,
    label: validated.translation.label,
    downloadBytes: validated.translation.downloadBytes,
    available: validated.translation.platforms.includes(`${platform}-${arch}`)
  });
  const rendererDto = deepFreeze({
    defaultModelId: validated.defaultModelId,
    models: Object.freeze(models),
    translation
  });

  return Object.freeze({
    defaultModelId: validated.defaultModelId,
    hasModel: (id) => typeof id === "string" && byId.has(id),
    getModel: (id) => byId.get(id) ?? null,
    isTranslationAvailable: (mode) => mode === "off" || (mode === translation.mode && translation.available),
    getRendererDto: () => rendererDto,
    getSpeakerFileName: () => validated.speakerFileName
  });
}

function validateFiles(value) {
  const candidates = array(value, 1, 64);
  const paths = new Set();
  return Object.freeze(candidates.map((candidate) => {
    const file = validateFile(candidate);
    uniqueCasefold(paths, file.path);
    return file;
  }));
}

function validateFile(value) {
  const file = record(value);
  exactKeys(file, FILE_KEYS);
  return Object.freeze({
    path: safeRelativePath(file.path),
    size: byteSize(file.size),
    sha256: sha256(file.sha256)
  });
}

function validateTranslationPlatforms(value) {
  const candidates = array(value, 1, 1);
  if (candidates[0] !== TRANSLATION_PLATFORM) invalid();
  return [TRANSLATION_PLATFORM];
}

function safeId(value) {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{0,63})$/.test(value)) invalid();
  return value;
}

function safeText(value, maxLength) {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value !== value.trim()) invalid();
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) invalid();
  return value;
}

function safeToken(value, maxLength) {
  if (typeof value !== "string" || value.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(value)) invalid();
  return value;
}

function safeRelativePath(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 512 || value.includes("\\")) invalid();
  const segments = value.split("/");
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._+@-]*$/.test(segment) || segment === "." || segment === "..")) {
    invalid();
  }
  return value;
}

function repository(value) {
  if (typeof value !== "string" || value.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    invalid();
  }
  return value;
}

function revision(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/.test(value)) invalid();
  return value;
}

function sha256(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) invalid();
  return value;
}

function license(value) {
  if (typeof value !== "string" || value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value)) invalid();
  return value;
}

function httpsUrl(value) {
  if (typeof value !== "string" || value.length > 2_048) invalid();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || parsed.hostname.length > 253) invalid();
  if (
    parsed.hostname === "localhost"
    || isIP(parsed.hostname) !== 0
    || !parsed.hostname.includes(".")
    || parsed.hostname.endsWith(".local")
  ) invalid();
  return value;
}

function translationArchiveUrl(value) {
  httpsUrl(value);
  // URL normalizes an explicit default port away (":443"), so validate the
  // raw authority as well as the parsed URL. This keeps Node's trust boundary
  // identical to the Python manifest loader: fixed host, no port, query,
  // credentials, or fragment, and an explicit absolute archive path.
  if (!value.startsWith(`${TRANSLATION_ARCHIVE_ORIGIN}/`)) invalid();
  if (!/^https:\/\/object\.pouta\.csc\.fi\/[^?#]+$/u.test(value)) invalid();
  const parsed = new URL(value);
  if (
    parsed.origin !== TRANSLATION_ARCHIVE_ORIGIN
    || parsed.hostname !== "object.pouta.csc.fi"
    || parsed.port
    || parsed.search
    || parsed.hash
    || !parsed.pathname.startsWith("/")
    || parsed.pathname === "/"
  ) invalid();
  return value;
}

function byteSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 20_000_000_000) invalid();
  return value;
}

function sumFileSizes(files) {
  let total = 0;
  for (const file of files) {
    total += file.size;
    if (!Number.isSafeInteger(total)) invalid();
  }
  return total;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) invalid();
}

function uniqueCasefold(set, value) {
  const key = value.toLocaleLowerCase("en-US");
  if (set.has(key)) invalid();
  set.add(key);
}

function oneOf(value, allowed) {
  const includes = Array.isArray(allowed) ? allowed.includes(value) : allowed.has(value);
  if (typeof value !== "string" || !includes) invalid();
  return value;
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value;
}

function array(value, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function invalid() {
  throw new ModelCatalogError("invalid_model_catalog");
}

class StrictJsonParser {
  constructor(source) {
    this.source = source;
    this.index = 0;
    this.items = 0;
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue(0);
    this.skipWhitespace();
    if (this.index !== this.source.length) invalid();
    return value;
  }

  parseValue(depth) {
    if (depth > MAX_DEPTH) invalid();
    const character = this.source[this.index];
    if (character === "{") return this.parseObject(depth + 1);
    if (character === "[") return this.parseArray(depth + 1);
    if (character === '"') return this.parseString();
    if (character === "t") return this.parseLiteral("true", true);
    if (character === "f") return this.parseLiteral("false", false);
    if (character === "n") return this.parseLiteral("null", null);
    if (character === "-" || (character >= "0" && character <= "9")) return this.parseNumber();
    invalid();
  }

  parseObject(depth) {
    this.index += 1;
    const value = Object.create(null);
    const keys = new Set();
    this.skipWhitespace();
    if (this.source[this.index] === "}") {
      this.index += 1;
      return value;
    }
    while (true) {
      if (this.source[this.index] !== '"') invalid();
      const key = this.parseString();
      if (keys.has(key)) throw new ModelCatalogError("duplicate_catalog_key");
      keys.add(key);
      this.bumpItems();
      this.skipWhitespace();
      if (this.source[this.index] !== ":") invalid();
      this.index += 1;
      this.skipWhitespace();
      value[key] = this.parseValue(depth);
      this.skipWhitespace();
      const separator = this.source[this.index];
      this.index += 1;
      if (separator === "}") return value;
      if (separator !== ",") invalid();
      this.skipWhitespace();
    }
  }

  parseArray(depth) {
    this.index += 1;
    const value = [];
    this.skipWhitespace();
    if (this.source[this.index] === "]") {
      this.index += 1;
      return value;
    }
    while (true) {
      this.bumpItems();
      value.push(this.parseValue(depth));
      this.skipWhitespace();
      const separator = this.source[this.index];
      this.index += 1;
      if (separator === "]") return value;
      if (separator !== ",") invalid();
      this.skipWhitespace();
    }
  }

  parseString() {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index);
      if (code === 0x22) {
        this.index += 1;
        const raw = this.source.slice(start, this.index);
        if (raw.length > MAX_STRING_LENGTH + 2) invalid();
        try {
          const value = JSON.parse(raw);
          if (value.length > MAX_STRING_LENGTH) invalid();
          return value;
        } catch {
          invalid();
        }
      }
      if (code < 0x20) invalid();
      if (code === 0x5c) {
        this.index += 1;
        const escape = this.source[this.index];
        if (!['"', "\\", "/", "b", "f", "n", "r", "t", "u"].includes(escape)) invalid();
        if (escape === "u") {
          const hex = this.source.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) invalid();
          this.index += 4;
        }
      }
      this.index += 1;
    }
    invalid();
  }

  parseNumber() {
    const remaining = this.source.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining);
    if (!match) invalid();
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) invalid();
    return value;
  }

  parseLiteral(literal, value) {
    if (this.source.slice(this.index, this.index + literal.length) !== literal) invalid();
    this.index += literal.length;
    return value;
  }

  skipWhitespace() {
    while ([" ", "\t", "\r", "\n"].includes(this.source[this.index])) this.index += 1;
  }

  bumpItems() {
    this.items += 1;
    if (this.items > MAX_CONTAINER_ITEMS) invalid();
  }
}
