import { randomUUID as createRandomUuid } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const CONTEXT_PACK_SCHEMA_VERSION = 1;

export const CONTEXT_PACK_KINDS = Object.freeze([
  "objective",
  "talking_points",
  "job_description",
  "resume",
  "product_facts",
  "presentation_notes",
  "custom_notes"
]);

export const CONTEXT_PACK_LIMITS = Object.freeze({
  maxItems: 24,
  maxSelectedItems: 12,
  maxNameChars: 120,
  maxNameUtf8Bytes: 240,
  maxContentChars: 32_000,
  maxContentUtf8Bytes: 64 * 1024,
  maxTotalUtf8Bytes: 256 * 1024,
  maxPlaintextFileBytes: 384 * 1024,
  maxEncryptedFileBytes: 768 * 1024
});

const KIND_SET = new Set(CONTEXT_PACK_KINDS);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const STORED_ROOT_KEYS = Object.freeze(["schemaVersion", "items"]);
const STORED_ITEM_KEYS = Object.freeze(["id", "revision", "kind", "name", "content"]);

export class ContextPackStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContextPackStoreError";
    this.code = code;
  }
}

export function createContextPackStore({
  contextPackPath,
  encrypt,
  decrypt,
  isEncryptionAvailable,
  fileSystem = fs,
  uuidFactory = createRandomUuid
} = {}) {
  if (typeof contextPackPath !== "string" || !path.isAbsolute(contextPackPath)) {
    throw new TypeError("contextPackPath must be an absolute path.");
  }
  if (typeof encrypt !== "function"
    || typeof decrypt !== "function"
    || typeof isEncryptionAvailable !== "function") {
    throw new TypeError("Encrypted context-pack storage dependencies are required.");
  }
  if (typeof uuidFactory !== "function") {
    throw new TypeError("uuidFactory must be a function.");
  }
  for (const method of ["open", "mkdir", "writeFile", "rename", "unlink"]) {
    if (typeof fileSystem?.[method] !== "function") {
      throw new TypeError(`fileSystem.${method} must be a function.`);
    }
  }

  let operationChain = Promise.resolve();

  function exclusively(operation) {
    const result = operationChain.then(operation, operation);
    operationChain = result.catch(() => {});
    return result;
  }

  async function encryptionAvailable() {
    try {
      return await isEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  async function list() {
    return exclusively(async () => {
      const state = await readState();
      return freezeItems(state.items);
    });
  }

  async function create(value) {
    return exclusively(async () => {
      const input = normalizeCreate(value);
      const state = await readState();
      if (state.items.length >= CONTEXT_PACK_LIMITS.maxItems) {
        throw limitError();
      }

      const item = {
        id: generateUniqueUuid(state.items, uuidFactory),
        revision: 1,
        ...input
      };
      const next = { schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, items: [...state.items, item] };
      validateUtf8Totals(next.items, { stored: false });
      await writeState(next);
      return freezeItem(item);
    });
  }

  async function update(value) {
    return exclusively(async () => {
      const input = normalizeUpdate(value);
      const state = await readState();
      const index = state.items.findIndex(({ id }) => id === input.id);
      if (index === -1) throw notFoundError();
      const current = state.items[index];
      requireExactRevision(current, input.revision);
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw revisionConflictError();

      const item = {
        ...current,
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.content === undefined ? {} : { content: input.content }),
        revision: current.revision + 1
      };
      const items = [...state.items];
      items[index] = item;
      validateUtf8Totals(items, { stored: false });
      await writeState({ schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, items });
      return freezeItem(item);
    });
  }

  async function deletePack(value) {
    return exclusively(async () => {
      const input = normalizeDelete(value);
      const state = await readState();
      const index = state.items.findIndex(({ id }) => id === input.id);
      if (index === -1) throw notFoundError();
      requireExactRevision(state.items[index], input.revision);

      const items = state.items.filter((_, itemIndex) => itemIndex !== index);
      await writeState({ schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, items });
      return Object.freeze({ id: input.id, revision: input.revision, deleted: true });
    });
  }

  async function resolveSelection(value) {
    return exclusively(async () => {
      const selection = normalizeSelection(value);
      const state = await readState();
      const byId = new Map(state.items.map((item) => [item.id, item]));
      const resolved = selection.map((reference) => {
        const item = byId.get(reference.id);
        if (!item) throw notFoundError();
        requireExactRevision(item, reference.revision);
        return item;
      });
      return freezeItems(resolved);
    });
  }

  async function readState() {
    await requireEncryptionAvailable();

    const serialized = await readBoundedEncryptedFile();
    if (serialized === null) {
      return { schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, items: [] };
    }

    const wrapperSource = bufferToBoundedUtf8(serialized, CONTEXT_PACK_LIMITS.maxEncryptedFileBytes);
    const wrapper = parseEncryptedWrapper(wrapperSource);
    let decrypted;
    try {
      decrypted = await decrypt(Buffer.from(wrapper.ciphertext, "base64"));
    } catch {
      throw new ContextPackStoreError(
        "context_pack_decryption_failed",
        "Saved meeting context could not be unlocked."
      );
    }

    const result = normalizeDecryptionResult(decrypted);
    const plaintext = requireBoundedPlaintext(result.plaintext);
    const state = parseStoredState(plaintext);
    if (result.shouldReEncrypt) await writeState(state);
    return state;
  }

  async function readBoundedEncryptedFile() {
    let handle;
    try {
      handle = await fileSystem.open(contextPackPath, "r");
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw readError();
    }

    const buffer = Buffer.allocUnsafe(CONTEXT_PACK_LIMITS.maxEncryptedFileBytes + 1);
    let total = 0;
    let failure = null;
    try {
      while (total < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          total,
          buffer.length - total,
          total
        );
        if (bytesRead === 0) break;
        total += bytesRead;
      }
      if (total > CONTEXT_PACK_LIMITS.maxEncryptedFileBytes) failure = corruptStoreError();
    } catch {
      failure = readError();
    }
    try {
      await handle.close();
    } catch {
      failure ??= readError();
    }
    if (failure) throw failure;
    return buffer.subarray(0, total);
  }

  async function writeState(value) {
    await requireEncryptionAvailable();
    const state = normalizeStoredState(value);
    const plaintext = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(plaintext, "utf8") > CONTEXT_PACK_LIMITS.maxPlaintextFileBytes) {
      throw limitError();
    }

    let encrypted;
    try {
      encrypted = await encrypt(plaintext);
    } catch {
      throw new ContextPackStoreError(
        "context_pack_encryption_failed",
        "Meeting context could not be encrypted."
      );
    }
    const ciphertext = normalizeCiphertext(encrypted);
    const serialized = `${JSON.stringify({
      schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
      ciphertext: ciphertext.toString("base64")
    })}\n`;
    if (Buffer.byteLength(serialized, "utf8") > CONTEXT_PACK_LIMITS.maxEncryptedFileBytes) {
      throw limitError();
    }

    const directory = path.dirname(contextPackPath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(contextPackPath)}.${process.pid}.${createRandomUuid()}.tmp`
    );
    try {
      await fileSystem.mkdir(directory, { recursive: true, mode: 0o700 });
      await fileSystem.writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await fileSystem.rename(temporaryPath, contextPackPath);
    } catch {
      throw new ContextPackStoreError(
        "context_pack_write_failed",
        "Meeting context could not be stored securely."
      );
    } finally {
      await fileSystem.unlink(temporaryPath).catch(() => {});
    }
  }

  async function requireEncryptionAvailable() {
    if (!await encryptionAvailable()) {
      throw new ContextPackStoreError(
        "secure_storage_unavailable",
        "Secure meeting-context storage is unavailable on this computer."
      );
    }
  }

  return Object.freeze({
    encryptionAvailable,
    list,
    create,
    update,
    delete: deletePack,
    resolveSelection,
    getSelected: resolveSelection
  });
}

function normalizeCreate(value) {
  const input = requireClosedRecord(value, ["kind", "name", "content"], "invalid_context_pack");
  return {
    kind: requireKind(input.kind),
    name: requireName(input.name),
    content: requireContent(input.content)
  };
}

function normalizeUpdate(value) {
  const input = requireAllowedRecord(
    value,
    ["id", "revision", "kind", "name", "content"],
    ["id", "revision"],
    "invalid_context_pack"
  );
  if (!("kind" in input) && !("name" in input) && !("content" in input)) {
    throw invalidPackError();
  }
  return {
    id: requireUuid(input.id, "invalid_context_pack"),
    revision: requirePositiveRevision(input.revision, "invalid_context_pack"),
    kind: "kind" in input ? requireKind(input.kind) : undefined,
    name: "name" in input ? requireName(input.name) : undefined,
    content: "content" in input ? requireContent(input.content) : undefined
  };
}

function normalizeDelete(value) {
  const input = requireClosedRecord(value, ["id", "revision"], "invalid_context_pack");
  return {
    id: requireUuid(input.id, "invalid_context_pack"),
    revision: requirePositiveRevision(input.revision, "invalid_context_pack")
  };
}

function normalizeSelection(value) {
  if (!Array.isArray(value) || value.length > CONTEXT_PACK_LIMITS.maxSelectedItems) {
    throw invalidSelectionError();
  }
  const seen = new Set();
  return value.map((candidate) => {
    const input = requireClosedRecord(candidate, ["id", "revision"], "invalid_context_selection");
    const reference = {
      id: requireUuid(input.id, "invalid_context_selection"),
      revision: requirePositiveRevision(input.revision, "invalid_context_selection")
    };
    if (seen.has(reference.id)) throw invalidSelectionError();
    seen.add(reference.id);
    return reference;
  });
}

function normalizeStoredState(value) {
  if (!isRecord(value) || !hasExactKeys(value, STORED_ROOT_KEYS)
    || value.schemaVersion !== CONTEXT_PACK_SCHEMA_VERSION
    || !Array.isArray(value.items)
    || value.items.length > CONTEXT_PACK_LIMITS.maxItems) {
    throw corruptStoreError();
  }
  const ids = new Set();
  const items = value.items.map((candidate) => {
    if (!isRecord(candidate) || !hasExactKeys(candidate, STORED_ITEM_KEYS)) {
      throw corruptStoreError();
    }
    const item = {
      id: requireStored(() => requireUuid(candidate.id, "invalid_context_pack")),
      revision: requireStored(() => requirePositiveRevision(candidate.revision, "invalid_context_pack")),
      kind: requireStored(() => requireKind(candidate.kind)),
      name: requireStored(() => requireName(candidate.name)),
      content: requireStored(() => requireContent(candidate.content))
    };
    if (ids.has(item.id)) throw corruptStoreError();
    ids.add(item.id);
    return item;
  });
  validateUtf8Totals(items, { stored: true });
  return { schemaVersion: CONTEXT_PACK_SCHEMA_VERSION, items };
}

function parseStoredState(plaintext) {
  let value;
  try {
    value = JSON.parse(plaintext);
  } catch {
    throw corruptStoreError();
  }
  const state = normalizeStoredState(value);
  if (plaintext !== `${JSON.stringify(state)}\n`) throw corruptStoreError();
  return state;
}

function parseEncryptedWrapper(source) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw corruptStoreError();
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ["schemaVersion", "ciphertext"])
    || value.schemaVersion !== CONTEXT_PACK_SCHEMA_VERSION
    || typeof value.ciphertext !== "string"
    || value.ciphertext.length === 0
    || !isCanonicalBase64(value.ciphertext)) {
    throw corruptStoreError();
  }
  if (source !== `${JSON.stringify({
    schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
    ciphertext: value.ciphertext
  })}\n`) {
    throw corruptStoreError();
  }
  return value;
}

function normalizeDecryptionResult(value) {
  if (typeof value === "string") return { plaintext: value, shouldReEncrypt: false };
  if (isRecord(value)
    && typeof value.result === "string"
    && (value.shouldReEncrypt === undefined || typeof value.shouldReEncrypt === "boolean")) {
    return { plaintext: value.result, shouldReEncrypt: value.shouldReEncrypt === true };
  }
  throw new ContextPackStoreError(
    "context_pack_decryption_failed",
    "Saved meeting context could not be unlocked."
  );
}

function normalizeCiphertext(value) {
  if (Buffer.isBuffer(value) && value.length > 0) return value;
  if (value instanceof Uint8Array && value.byteLength > 0) return Buffer.from(value);
  throw new ContextPackStoreError(
    "context_pack_encryption_failed",
    "Meeting context could not be encrypted."
  );
}

function bufferToBoundedUtf8(value, maxBytes) {
  if (!(typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array)) {
    throw corruptStoreError();
  }
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value.byteLength;
  if (bytes === 0 || bytes > maxBytes) throw corruptStoreError();
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function requireBoundedPlaintext(value) {
  if (Buffer.byteLength(value, "utf8") > CONTEXT_PACK_LIMITS.maxPlaintextFileBytes) {
    throw corruptStoreError();
  }
  return value;
}

function requireKind(value) {
  if (!KIND_SET.has(value)) throw invalidPackError();
  return value;
}

function requireName(value) {
  if (typeof value !== "string") throw invalidPackError();
  if (value.length === 0 || value.length > CONTEXT_PACK_LIMITS.maxNameChars) {
    throw invalidPackError();
  }
  const normalized = value.trim();
  if (normalized.length === 0
    || Buffer.byteLength(normalized, "utf8") > CONTEXT_PACK_LIMITS.maxNameUtf8Bytes
    || containsUnsafeControl(normalized)
    || hasUnpairedSurrogate(normalized)) {
    throw invalidPackError();
  }
  return normalized;
}

function requireContent(value) {
  if (typeof value !== "string") throw invalidPackError();
  if (value.length === 0
    || value.length > CONTEXT_PACK_LIMITS.maxContentChars
    || value.trim().length === 0
    || Buffer.byteLength(value, "utf8") > CONTEXT_PACK_LIMITS.maxContentUtf8Bytes
    || containsUnsafeContentControl(value)
    || hasUnpairedSurrogate(value)) {
    throw invalidPackError();
  }
  return value;
}

function requireUuid(value, errorCode) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    if (errorCode === "invalid_context_selection") throw invalidSelectionError();
    throw invalidPackError();
  }
  return value;
}

function requirePositiveRevision(value, errorCode) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    if (errorCode === "invalid_context_selection") throw invalidSelectionError();
    throw invalidPackError();
  }
  return value;
}

function requireClosedRecord(value, exactKeys, errorCode) {
  if (!isRecord(value) || !hasExactKeys(value, exactKeys)) {
    if (errorCode === "invalid_context_selection") throw invalidSelectionError();
    throw invalidPackError();
  }
  return value;
}

function requireAllowedRecord(value, allowedKeys, requiredKeys, errorCode) {
  if (!isRecord(value)) throw invalidPackError();
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || requiredKeys.some((key) => !(key in value))) {
    if (errorCode === "invalid_context_selection") throw invalidSelectionError();
    throw invalidPackError();
  }
  return value;
}

function requireStored(operation) {
  try {
    return operation();
  } catch {
    throw corruptStoreError();
  }
}

function validateUtf8Totals(items, { stored }) {
  const total = items.reduce(
    (sum, item) => sum + Buffer.byteLength(item.name, "utf8") + Buffer.byteLength(item.content, "utf8"),
    0
  );
  if (total > CONTEXT_PACK_LIMITS.maxTotalUtf8Bytes) {
    if (stored) throw corruptStoreError();
    throw limitError();
  }
}

function generateUniqueUuid(items, uuidFactory) {
  const ids = new Set(items.map(({ id }) => id));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let candidate;
    try {
      candidate = uuidFactory();
    } catch {
      throw idGenerationError();
    }
    if (typeof candidate !== "string" || !UUID_PATTERN.test(candidate)) {
      throw idGenerationError();
    }
    if (!ids.has(candidate)) return candidate;
  }
  throw idGenerationError();
}

function requireExactRevision(item, revision) {
  if (item.revision !== revision) throw revisionConflictError();
}

function freezeItems(items) {
  return Object.freeze(items.map(freezeItem));
}

function freezeItem(item) {
  return Object.freeze({
    id: item.id,
    revision: item.revision,
    kind: item.kind,
    name: item.name,
    content: item.content
  });
}

function isCanonicalBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function hasExactKeys(value, exactKeys) {
  const keys = Object.keys(value);
  const expected = new Set(exactKeys);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function containsUnsafeControl(value) {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function containsUnsafeContentControl(value) {
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function invalidPackError() {
  return new ContextPackStoreError(
    "invalid_context_pack",
    "The meeting context pack is invalid."
  );
}

function invalidSelectionError() {
  return new ContextPackStoreError(
    "invalid_context_selection",
    "The selected meeting context is invalid."
  );
}

function limitError() {
  return new ContextPackStoreError(
    "context_pack_limit_exceeded",
    "Saved meeting context exceeds the local storage limit."
  );
}

function notFoundError() {
  return new ContextPackStoreError(
    "context_pack_not_found",
    "The selected meeting context pack no longer exists."
  );
}

function revisionConflictError() {
  return new ContextPackStoreError(
    "context_pack_revision_conflict",
    "The meeting context pack changed. Review the latest version before continuing."
  );
}

function corruptStoreError() {
  return new ContextPackStoreError(
    "context_pack_corrupt",
    "Saved meeting context is invalid and was not changed."
  );
}

function readError() {
  return new ContextPackStoreError(
    "context_pack_read_failed",
    "Saved meeting context could not be read."
  );
}

function idGenerationError() {
  return new ContextPackStoreError(
    "context_pack_id_failed",
    "A meeting context pack identifier could not be created."
  );
}
