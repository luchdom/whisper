import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProviderCredentialStore } from "../main/provider-credential-store.js";

test("credential store persists ciphertext only and never returns the key from import or status", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const credentialPath = path.join(directory, "provider-credential.json");
  const key = "sk-test-secret-value-123456789";
  const safeStorage = createFakeSafeStorage();
  const store = createProviderCredentialStore({ credentialPath, safeStorage });

  assert.equal(await store.getConfigured(), false);
  assert.equal(await store.getCredentialState(), "absent");
  assert.deepEqual(await store.importKey(key), { configured: true });
  assert.equal(await store.getConfigured(), true);
  assert.equal(await store.getCredentialState(), "configured");

  const serialized = await fs.readFile(credentialPath, "utf8");
  const record = JSON.parse(serialized);
  assert.equal(serialized.includes(key), false);
  assert.deepEqual(Object.keys(record).sort(), ["ciphertext", "version"]);
  assert.notEqual(Buffer.from(record.ciphertext, "base64").toString("utf8"), key);
  assert.equal(await store.decryptForRequest(), key);
  assert.deepEqual(await fs.readdir(directory), ["provider-credential.json"]);
});

test("credential store validates printable sk-* keys without echoing rejected input", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const rejected = "plain-text-private-value";
  const store = createProviderCredentialStore({
    credentialPath: path.join(directory, "credential.json"),
    safeStorage: createFakeSafeStorage()
  });

  const error = await store.importKey(rejected).catch((failure) => failure);
  assert.equal(error.code, "invalid_credential");
  assert.equal(error.message.includes(rejected), false);
  await assert.rejects(store.importKey("sk-line\nbreak"), { code: "invalid_credential" });
  assert.equal(await store.getConfigured(), false);
});

test("credential store fails closed when asynchronous OS encryption is unavailable", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  let encryptCalls = 0;
  const store = createProviderCredentialStore({
    credentialPath: path.join(directory, "credential.json"),
    safeStorage: {
      async isAsyncEncryptionAvailable() { return false; },
      async encryptStringAsync() { encryptCalls += 1; return Buffer.from("no"); },
      async decryptStringAsync() { throw new Error("must not decrypt"); }
    }
  });

  await assert.rejects(store.importKey("sk-test-1234567890"), {
    code: "secure_storage_unavailable"
  });
  assert.equal(encryptCalls, 0);
});

test("credential store re-encrypts rotated ciphertext and supports revocation", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const credentialPath = path.join(directory, "credential.json");
  const safeStorage = createFakeSafeStorage({ shouldReEncryptOnce: true });
  const store = createProviderCredentialStore({ credentialPath, safeStorage });
  const key = "sk-rotate-test-1234567890";

  await store.importKey(key);
  const before = JSON.parse(await fs.readFile(credentialPath, "utf8")).ciphertext;
  assert.equal(await store.decryptForRequest(), key);
  const after = JSON.parse(await fs.readFile(credentialPath, "utf8")).ciphertext;
  assert.notEqual(after, before);
  assert.equal(safeStorage.encryptCalls, 2);

  assert.equal(await store.revoke(), true);
  assert.equal(await store.revoke(), false);
  assert.equal(await store.getConfigured(), false);
  await assert.rejects(store.decryptForRequest(), { code: "credential_missing" });
});

test("credential store treats malformed files as unconfigured and never decrypts them", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const credentialPath = path.join(directory, "credential.json");
  const safeStorage = createFakeSafeStorage();
  const store = createProviderCredentialStore({ credentialPath, safeStorage });
  await fs.writeFile(credentialPath, JSON.stringify({ version: 1, ciphertext: "not base64!" }));
  const serializedBeforeImport = await fs.readFile(credentialPath, "utf8");

  assert.equal(await store.getConfigured(), false);
  assert.equal(await store.getCredentialState(), "invalid");
  const importError = await store.importKey("sk-replacement-test-1234567890").catch((error) => error);
  assert.equal(importError.code, "credential_cleanup_required");
  assert.equal(importError.message, "Remove the saved OpenAI API key before importing another key.");
  assert.equal(safeStorage.encryptCalls, 0);
  assert.equal(await fs.readFile(credentialPath, "utf8"), serializedBeforeImport);
  assert.deepEqual(await fs.readdir(directory), ["credential.json"]);
  await assert.rejects(store.decryptForRequest(), { code: "credential_corrupt" });
  assert.equal(safeStorage.decryptCalls, 0);
  assert.equal(await store.revoke(), true, "revocation unlinks malformed artifacts without parsing them");
  assert.equal(await store.getCredentialState(), "absent");
});

test("credential store reports unreadable artifacts without details and still attempts exact-path revocation", async () => {
  let unlinkCalls = 0;
  let writeCalls = 0;
  const safeStorage = createFakeSafeStorage();
  const fileSystem = {
    async readFile() {
      throw Object.assign(new Error("private path and OS detail"), { code: "EACCES" });
    },
    async mkdir() {
      writeCalls += 1;
    },
    async writeFile() {
      writeCalls += 1;
    },
    async rename() {
      writeCalls += 1;
    },
    async unlink() {
      unlinkCalls += 1;
    }
  };
  const store = createProviderCredentialStore({
    credentialPath: path.resolve("private-user-data", "credential.json"),
    safeStorage,
    fileSystem
  });

  assert.equal(await store.getCredentialState(), "unreadable");
  assert.equal(await store.getConfigured(), false);
  const importError = await store.importKey("sk-replacement-test-1234567890").catch((error) => error);
  assert.equal(importError.code, "credential_cleanup_required");
  assert.equal(importError.message, "Remove the saved OpenAI API key before importing another key.");
  assert.equal(importError.message.includes("private path"), false);
  assert.equal(safeStorage.encryptCalls, 0);
  assert.equal(writeCalls, 0);
  assert.equal(await store.revoke(), true);
  assert.equal(unlinkCalls, 1);
});

test("credential store permits an explicit configured-key rotation", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const credentialPath = path.join(directory, "credential.json");
  const safeStorage = createFakeSafeStorage();
  const store = createProviderCredentialStore({ credentialPath, safeStorage });

  await store.importKey("sk-original-test-1234567890");
  assert.deepEqual(await store.importKey("sk-replacement-test-1234567890"), { configured: true });
  assert.equal(safeStorage.encryptCalls, 2);
  assert.equal(await store.decryptForRequest(), "sk-replacement-test-1234567890");
  assert.deepEqual(await fs.readdir(directory), ["credential.json"]);
});

function createFakeSafeStorage({ shouldReEncryptOnce = false } = {}) {
  let generation = 0;
  let shouldReEncrypt = shouldReEncryptOnce;
  const values = new Map();
  return {
    encryptCalls: 0,
    decryptCalls: 0,
    async isAsyncEncryptionAvailable() { return true; },
    async encryptStringAsync(value) {
      this.encryptCalls += 1;
      const token = `cipher-${++generation}`;
      values.set(token, value);
      return Buffer.from(token, "utf8");
    },
    async decryptStringAsync(buffer) {
      this.decryptCalls += 1;
      const result = values.get(buffer.toString("utf8"));
      if (!result) throw new Error("unknown ciphertext");
      const rotate = shouldReEncrypt;
      shouldReEncrypt = false;
      return { result, shouldReEncrypt: rotate };
    }
  };
}

async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "provider-credential-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
