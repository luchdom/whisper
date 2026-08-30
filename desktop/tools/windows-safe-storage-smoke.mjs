import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createContextPackStore } from "../main/context-pack-store.js";
import { createProviderCredentialStore } from "../main/provider-credential-store.js";

const PROBE_NAME = "windows_safe_storage";
const SCHEMA_VERSION = 1;
const CONTRACT_ARGUMENT = "--contract-only";

class SafeStorageSmokeError extends Error {
  constructor(code) {
    super(code);
    this.name = "SafeStorageSmokeError";
    this.code = code;
  }
}

function fail(code) {
  throw new SafeStorageSmokeError(code);
}

function contractResult() {
  return {
    schemaVersion: SCHEMA_VERSION,
    probe: PROBE_NAME,
    mode: "contract_only",
    passed: true,
    requirements: {
      aggregateOnly: true,
      cleanupRequired: true,
      electronRuntimeRequired: true,
      isolatedStorageRequired: true,
      windowsHostRequired: true
    }
  };
}

function baseRuntimeResult() {
  return {
    schemaVersion: SCHEMA_VERSION,
    probe: PROBE_NAME,
    mode: "runtime",
    passed: false,
    backend: "windows_dpapi",
    checks: {
      electronRuntime: false,
      windowsHost: false,
      encryptionAvailable: false,
      credentialWrite: false,
      credentialRestartDecrypt: false,
      credentialReEncryption: "not_checked",
      credentialRevoke: false,
      contextWrite: false,
      contextRestartList: false,
      contextReEncryption: false,
      contextDelete: false,
      plaintextScan: false,
      cleanup: false
    },
    counts: {
      stores: 2,
      restartReads: 0,
      plaintextLeaks: 0,
      remainingFiles: 0
    },
    errorCode: null
  };
}

async function main() {
  const argumentsProvided = process.argv.slice(1).filter((value) => value.startsWith("--"));
  if (argumentsProvided.includes(CONTRACT_ARGUMENT)) {
    if (argumentsProvided.some((value) => value !== CONTRACT_ARGUMENT)) {
      emit({ ...contractResult(), passed: false, errorCode: "invalid_arguments" });
      return 1;
    }
    emit(contractResult());
    return 0;
  }

  const result = baseRuntimeResult();
  let electronApp = null;
  let isolatedDirectory = null;
  let cleanupFailure = false;

  try {
    if (!process.versions.electron) fail("electron_runtime_required");
    result.checks.electronRuntime = true;

    if (process.platform !== "win32") fail("unsupported_host");
    result.checks.windowsHost = true;

    const electron = await import("electron");
    electronApp = electron.app;
    const { safeStorage } = electron;
    if (!electronApp || !safeStorage) fail("electron_runtime_required");

    isolatedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-transcriber-safe-storage-"));
    electronApp.setPath("userData", isolatedDirectory);
    await electronApp.whenReady();

    const synchronousAvailable = safeStorage.isEncryptionAvailable() === true;
    const asynchronousAvailable = await safeStorage.isAsyncEncryptionAvailable() === true;
    if (!synchronousAvailable || !asynchronousAvailable) fail("secure_storage_unavailable");
    result.checks.encryptionAvailable = true;

    const canaries = createSyntheticCanaries();
    const credentialPath = path.join(isolatedDirectory, "provider-credential.json");
    const contextPackPath = path.join(isolatedDirectory, "meeting-context-packs.json");

    await exerciseCredentialStore({
      credentialPath,
      safeStorage,
      canaries,
      result
    });
    await assertNoPlaintextLeak(isolatedDirectory, canaries.all);

    await exerciseContextPackStore({
      contextPackPath,
      safeStorage,
      canaries,
      result
    });
    await assertNoPlaintextLeak(isolatedDirectory, canaries.all);

    result.checks.plaintextScan = true;
    result.counts.plaintextLeaks = 0;

    const entriesBeforeCleanup = await listFiles(isolatedDirectory);
    if (entriesBeforeCleanup.length !== 1) fail("temporary_artifact_detected");

    result.passed = true;
  } catch (error) {
    result.errorCode = error instanceof SafeStorageSmokeError
      ? error.code
      : "unexpected_failure";
    if (result.errorCode.includes("plaintext_leak")) {
      result.counts.plaintextLeaks = 1;
    }
  } finally {
    if (isolatedDirectory) {
      try {
        await fs.rm(isolatedDirectory, { recursive: true, force: true, maxRetries: 3 });
        try {
          await fs.access(isolatedDirectory);
          cleanupFailure = true;
        } catch (error) {
          cleanupFailure = error?.code !== "ENOENT";
        }
      } catch {
        cleanupFailure = true;
      }
    } else {
      cleanupFailure = result.checks.electronRuntime && result.checks.windowsHost;
    }

    result.checks.cleanup = !cleanupFailure;
    result.counts.remainingFiles = cleanupFailure ? 1 : 0;
    if (cleanupFailure) {
      result.passed = false;
      result.errorCode = "cleanup_incomplete";
    }
    if (!result.passed && result.errorCode === null) {
      result.errorCode = "smoke_incomplete";
    }

    emit(result);
    if (electronApp) electronApp.exit(result.passed ? 0 : 1);
  }

  return result.passed ? 0 : 1;
}

function createSyntheticCanaries() {
  const credential = `sk-smoke-${randomUUID()}`;
  const contextName = `Synthetic context ${randomUUID()}`;
  const contextInitial = `Synthetic private context ${randomUUID()}`;
  const contextRevised = `Synthetic revised context ${randomUUID()}`;
  return Object.freeze({
    credential,
    contextName,
    contextInitial,
    contextRevised,
    all: Object.freeze([credential, contextName, contextInitial, contextRevised])
  });
}

async function exerciseCredentialStore({ credentialPath, safeStorage, canaries, result }) {
  const observations = {
    decryptions: 0,
    encryptions: 0,
    reEncryptionRequested: false
  };
  const trackedSafeStorage = {
    async isAsyncEncryptionAvailable() {
      return safeStorage.isAsyncEncryptionAvailable();
    },
    async encryptStringAsync(plaintext) {
      observations.encryptions += 1;
      return safeStorage.encryptStringAsync(plaintext);
    },
    async decryptStringAsync(ciphertext) {
      observations.decryptions += 1;
      const decrypted = await safeStorage.decryptStringAsync(ciphertext);
      observations.reEncryptionRequested ||= decrypted?.shouldReEncrypt === true;
      return decrypted;
    }
  };

  const initialStore = createProviderCredentialStore({ credentialPath, safeStorage: trackedSafeStorage });
  if (!await initialStore.isEncryptionAvailable()) fail("secure_storage_unavailable");
  await initialStore.importKey(canaries.credential);
  const beforeRestart = await fs.readFile(credentialPath);
  if (bufferContainsAnyCanary(beforeRestart, canaries.all)) fail("credential_plaintext_leak");
  result.checks.credentialWrite = true;

  const restartedStore = createProviderCredentialStore({ credentialPath, safeStorage: trackedSafeStorage });
  if (await restartedStore.getCredentialState() !== "configured") fail("credential_restart_failed");
  if (await restartedStore.decryptForRequest() !== canaries.credential) fail("credential_restart_failed");
  result.checks.credentialRestartDecrypt = true;
  result.counts.restartReads += 1;

  const afterRestart = await fs.readFile(credentialPath);
  if (observations.reEncryptionRequested) {
    if (observations.encryptions < 2 || beforeRestart.equals(afterRestart)) {
      fail("credential_reencryption_incomplete");
    }
    result.checks.credentialReEncryption = "completed";
  } else {
    result.checks.credentialReEncryption = "not_needed";
  }
  if (observations.decryptions !== 1) fail("credential_restart_failed");
  if (bufferContainsAnyCanary(afterRestart, canaries.all)) fail("credential_plaintext_leak");

  if (!await restartedStore.revoke()) fail("credential_revoke_incomplete");
  const revokedStore = createProviderCredentialStore({ credentialPath, safeStorage: trackedSafeStorage });
  if (await revokedStore.getCredentialState() !== "absent") fail("credential_revoke_incomplete");
  result.checks.credentialRevoke = true;
  result.counts.restartReads += 1;
}

async function exerciseContextPackStore({ contextPackPath, safeStorage, canaries, result }) {
  function createStore() {
    return createContextPackStore({
      contextPackPath,
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plaintext) => safeStorage.encryptString(plaintext),
      decrypt: (ciphertext) => safeStorage.decryptString(ciphertext)
    });
  }

  const initialStore = createStore();
  if (!await initialStore.encryptionAvailable()) fail("secure_storage_unavailable");
  const created = await initialStore.create({
    kind: "custom_notes",
    name: canaries.contextName,
    content: canaries.contextInitial
  });
  const beforeRestart = await fs.readFile(contextPackPath);
  if (bufferContainsAnyCanary(beforeRestart, canaries.all)) fail("context_plaintext_leak");
  result.checks.contextWrite = true;

  const restartedStore = createStore();
  const listed = await restartedStore.list();
  if (listed.length !== 1
    || listed[0].id !== created.id
    || listed[0].revision !== created.revision
    || listed[0].name !== canaries.contextName
    || listed[0].content !== canaries.contextInitial) {
    fail("context_restart_failed");
  }
  result.checks.contextRestartList = true;
  result.counts.restartReads += 1;

  const updated = await restartedStore.update({
    id: created.id,
    revision: created.revision,
    content: canaries.contextRevised
  });
  const afterReEncryption = await fs.readFile(contextPackPath);
  if (beforeRestart.equals(afterReEncryption)
    || bufferContainsAnyCanary(afterReEncryption, canaries.all)) {
    fail("context_reencryption_incomplete");
  }

  const reloadedStore = createStore();
  const reloaded = await reloadedStore.list();
  if (reloaded.length !== 1
    || reloaded[0].revision !== updated.revision
    || reloaded[0].content !== canaries.contextRevised) {
    fail("context_reencryption_incomplete");
  }
  result.checks.contextReEncryption = true;
  result.counts.restartReads += 1;

  await reloadedStore.delete({ id: updated.id, revision: updated.revision });
  const deletedStore = createStore();
  if ((await deletedStore.list()).length !== 0) fail("context_delete_incomplete");
  if (bufferContainsAnyCanary(await fs.readFile(contextPackPath), canaries.all)) {
    fail("context_plaintext_leak");
  }
  result.checks.contextDelete = true;
  result.counts.restartReads += 1;
}

async function assertNoPlaintextLeak(directory, canaries) {
  for (const filePath of await listFiles(directory)) {
    const contents = await fs.readFile(filePath);
    if (bufferContainsAnyCanary(contents, canaries)) fail("plaintext_leak");
  }
}

function bufferContainsAnyCanary(buffer, canaries) {
  return canaries.some((canary) => (
    buffer.includes(Buffer.from(canary, "utf8"))
      || buffer.includes(Buffer.from(canary, "utf16le"))
  ));
}

async function listFiles(directory) {
  const files = [];
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) files.push(entryPath);
      else fail("unexpected_storage_entry");
    }
  }
  return files;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

void main().then((exitCode) => {
  process.exitCode = exitCode;
});
