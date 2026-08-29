import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CREDENTIAL_VERSION = 1;
const MAX_CREDENTIAL_FILE_BYTES = 16_384;
const API_KEY_PATTERN = /^sk-[\x21-\x7e]{8,508}$/u;

export class ProviderCredentialError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderCredentialError";
    this.code = code;
  }
}

export function createProviderCredentialStore({
  credentialPath,
  safeStorage,
  fileSystem = fs
} = {}) {
  if (typeof credentialPath !== "string" || !path.isAbsolute(credentialPath)) {
    throw new TypeError("credentialPath must be an absolute path.");
  }
  if (!safeStorage || typeof safeStorage !== "object") {
    throw new TypeError("Electron safeStorage is required.");
  }

  let operationChain = Promise.resolve();

  function exclusively(operation) {
    const result = operationChain.then(operation, operation);
    operationChain = result.catch(() => {});
    return result;
  }

  async function isEncryptionAvailable() {
    if (typeof safeStorage.isAsyncEncryptionAvailable !== "function"
      || typeof safeStorage.encryptStringAsync !== "function"
      || typeof safeStorage.decryptStringAsync !== "function") {
      return false;
    }
    try {
      return await safeStorage.isAsyncEncryptionAvailable() === true;
    } catch {
      return false;
    }
  }

  async function getConfigured() {
    return exclusively(async () => (await inspectRecord()).state === "configured");
  }

  async function getCredentialState() {
    return exclusively(async () => (await inspectRecord()).state);
  }

  async function importKey(value) {
    return exclusively(async () => {
      const apiKey = validateApiKey(value);
      const existing = await inspectRecord();
      if (["invalid", "unreadable"].includes(existing.state)) {
        throw new ProviderCredentialError(
          "credential_cleanup_required",
          "Remove the saved OpenAI API key before importing another key."
        );
      }
      if (!await isEncryptionAvailable()) {
        throw new ProviderCredentialError(
          "secure_storage_unavailable",
          "Secure credential storage is unavailable on this computer."
        );
      }

      let encrypted;
      try {
        encrypted = await safeStorage.encryptStringAsync(apiKey);
      } catch {
        throw new ProviderCredentialError(
          "credential_encryption_failed",
          "The OpenAI API key could not be stored securely."
        );
      }
      if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
        throw new ProviderCredentialError(
          "credential_encryption_failed",
          "The OpenAI API key could not be stored securely."
        );
      }

      await writeRecord({
        version: CREDENTIAL_VERSION,
        ciphertext: encrypted.toString("base64")
      });
      return Object.freeze({ configured: true });
    });
  }

  async function decryptForRequest() {
    return exclusively(async () => {
      if (!await isEncryptionAvailable()) {
        throw new ProviderCredentialError(
          "secure_storage_unavailable",
          "Secure credential storage is unavailable on this computer."
        );
      }
      const record = await readRecord({ tolerateInvalid: false });
      if (!record) {
        throw new ProviderCredentialError(
          "credential_missing",
          "Add an OpenAI API key before requesting assistance."
        );
      }

      let decrypted;
      try {
        decrypted = await safeStorage.decryptStringAsync(Buffer.from(record.ciphertext, "base64"));
      } catch {
        throw new ProviderCredentialError(
          "credential_decryption_failed",
          "The saved OpenAI API key could not be unlocked."
        );
      }

      const apiKey = validateDecryptedResult(decrypted);
      if (decrypted.shouldReEncrypt === true) {
        let refreshed;
        try {
          refreshed = await safeStorage.encryptStringAsync(apiKey);
        } catch {
          throw new ProviderCredentialError(
            "credential_reencryption_failed",
            "The saved OpenAI API key could not be refreshed securely."
          );
        }
        if (!Buffer.isBuffer(refreshed) || refreshed.length === 0) {
          throw new ProviderCredentialError(
            "credential_reencryption_failed",
            "The saved OpenAI API key could not be refreshed securely."
          );
        }
        await writeRecord({
          version: CREDENTIAL_VERSION,
          ciphertext: refreshed.toString("base64")
        });
      }
      return apiKey;
    });
  }

  async function revoke() {
    return exclusively(async () => {
      try {
        await fileSystem.unlink(credentialPath);
        return true;
      } catch (error) {
        if (error?.code === "ENOENT") return false;
        throw new ProviderCredentialError(
          "credential_revoke_failed",
          "The saved OpenAI API key could not be removed."
        );
      }
    });
  }

  async function readRecord({ tolerateInvalid }) {
    const inspected = await inspectRecord();
    if (inspected.state === "configured") return inspected.record;
    if (inspected.state === "absent") return null;
    if (tolerateInvalid) return null;
    if (inspected.state === "unreadable") {
      throw new ProviderCredentialError(
        "credential_read_failed",
        "The saved OpenAI API key could not be read."
      );
    }
    throw corruptCredentialError();
  }

  async function inspectRecord() {
    let serialized;
    try {
      serialized = await fileSystem.readFile(credentialPath, "utf8");
    } catch (error) {
      return { state: error?.code === "ENOENT" ? "absent" : "unreadable", record: null };
    }

    if (Buffer.byteLength(serialized, "utf8") > MAX_CREDENTIAL_FILE_BYTES) {
      return { state: "invalid", record: null };
    }

    try {
      const value = JSON.parse(serialized);
      if (!isRecord(value)
        || Object.keys(value).sort().join(",") !== "ciphertext,version"
        || value.version !== CREDENTIAL_VERSION
        || typeof value.ciphertext !== "string"
        || value.ciphertext.length === 0
        || value.ciphertext.length > MAX_CREDENTIAL_FILE_BYTES
        || !isCanonicalBase64(value.ciphertext)) {
        return { state: "invalid", record: null };
      }
      return { state: "configured", record: value };
    } catch {
      return { state: "invalid", record: null };
    }
  }

  async function writeRecord(record) {
    const directory = path.dirname(credentialPath);
    const temporaryPath = path.join(
      directory,
      `.${path.basename(credentialPath)}.${process.pid}.${randomUUID()}.tmp`
    );
    const serialized = `${JSON.stringify(record, null, 2)}\n`;

    try {
      await fileSystem.mkdir(directory, { recursive: true });
      await fileSystem.writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await fileSystem.rename(temporaryPath, credentialPath);
    } catch {
      throw new ProviderCredentialError(
        "credential_write_failed",
        "The OpenAI API key could not be stored securely."
      );
    } finally {
      await fileSystem.unlink(temporaryPath).catch(() => {});
    }
  }

  return Object.freeze({
    credentialPath,
    isEncryptionAvailable,
    getConfigured,
    getCredentialState,
    importKey,
    decryptForRequest,
    revoke
  });
}

function validateApiKey(value) {
  if (typeof value !== "string" || !API_KEY_PATTERN.test(value)) {
    throw new ProviderCredentialError(
      "invalid_credential",
      "The OpenAI API key format is invalid."
    );
  }
  return value;
}

function validateDecryptedResult(value) {
  if (!isRecord(value) || typeof value.result !== "string") {
    throw new ProviderCredentialError(
      "credential_decryption_failed",
      "The saved OpenAI API key could not be unlocked."
    );
  }
  try {
    return validateApiKey(value.result);
  } catch {
    throw new ProviderCredentialError(
      "credential_decryption_failed",
      "The saved OpenAI API key could not be unlocked."
    );
  }
}

function corruptCredentialError() {
  return new ProviderCredentialError(
    "credential_corrupt",
    "The saved OpenAI API key is invalid. Remove it and add it again."
  );
}

function isCanonicalBase64(value) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
