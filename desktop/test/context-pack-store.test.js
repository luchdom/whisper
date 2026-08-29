import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTEXT_PACK_KINDS,
  CONTEXT_PACK_LIMITS,
  CONTEXT_PACK_SCHEMA_VERSION,
  ContextPackStoreError,
  createContextPackStore
} from "../main/context-pack-store.js";

test("missing storage loads an immutable empty list through available encryption", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const encryption = createFakeEncryption();
  const store = createStore(directory, { encryption });

  const items = await store.list();
  assert.deepEqual(items, []);
  assert.equal(Object.isFrozen(items), true);
  assert.equal(await store.encryptionAvailable(), true);
  await assert.rejects(fs.access(path.join(directory, "context-packs.json")), { code: "ENOENT" });
});

test("create writes only versioned ciphertext atomically with 0600 creation mode", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const encryption = createFakeEncryption();
  const writes = [];
  const fileSystem = createFileSystemProxy({
    async writeFile(...args) {
      writes.push({ target: args[0], options: args[2] });
      return fs.writeFile(...args);
    }
  });
  const store = createStore(directory, { encryption, fileSystem });
  const content = "  Private customer goal: reduce cycle time by 20%.\n";

  const created = await store.create({ kind: "objective", name: " Q4 objective ", content });
  assert.deepEqual(created, {
    id: uuidFor(1),
    revision: 1,
    kind: "objective",
    name: "Q4 objective",
    content
  });
  assert.equal(Object.isFrozen(created), true);

  const serialized = await fs.readFile(path.join(directory, "context-packs.json"), "utf8");
  assert.equal(serialized.includes(content), false);
  assert.equal(serialized.includes("Q4 objective"), false);
  assert.deepEqual(Object.keys(JSON.parse(serialized)), ["schemaVersion", "ciphertext"]);
  assert.equal(JSON.parse(serialized).schemaVersion, CONTEXT_PACK_SCHEMA_VERSION);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].options.flag, "wx");
  assert.equal(writes[0].options.mode, 0o600);
  assert.match(path.basename(writes[0].target), /^\.context-packs\.json\..+\.tmp$/u);
  assert.deepEqual(await fs.readdir(directory), ["context-packs.json"]);

  const listed = await store.list();
  assert.deepEqual(listed, [created]);
  assert.equal(Object.isFrozen(listed), true);
  assert.equal(Object.isFrozen(listed[0]), true);
});

test("all schema-v1 context kinds round-trip and UUIDs are always main-generated", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const store = createStore(directory);

  for (const [index, kind] of CONTEXT_PACK_KINDS.entries()) {
    await store.create({ kind, name: `Pack ${index + 1}`, content: `Content for ${kind}` });
  }
  assert.deepEqual((await store.list()).map(({ kind }) => kind), CONTEXT_PACK_KINDS);

  await assert.rejects(store.create({
    id: uuidFor(99),
    kind: "custom_notes",
    name: "Renderer ID",
    content: "Must not be accepted."
  }), { code: "invalid_context_pack" });
});

test("update and delete require the exact current per-item revision", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const store = createStore(directory);
  const created = await store.create({
    kind: "talking_points",
    name: "Discovery",
    content: "Ask about the current workflow."
  });

  const updated = await store.update({
    id: created.id,
    revision: created.revision,
    kind: "custom_notes",
    name: "Updated discovery",
    content: "Ask about workflow and decision criteria."
  });
  assert.deepEqual(updated, {
    id: created.id,
    revision: 2,
    kind: "custom_notes",
    name: "Updated discovery",
    content: "Ask about workflow and decision criteria."
  });

  const beforeConflicts = await fs.readFile(path.join(directory, "context-packs.json"));
  await assert.rejects(store.update({ id: created.id, revision: 1, name: "Stale" }), {
    code: "context_pack_revision_conflict"
  });
  await assert.rejects(store.delete({ id: created.id, revision: 1 }), {
    code: "context_pack_revision_conflict"
  });
  assert.deepEqual(await fs.readFile(path.join(directory, "context-packs.json")), beforeConflicts);

  assert.deepEqual(await store.delete({ id: updated.id, revision: 2 }), {
    id: updated.id,
    revision: 2,
    deleted: true
  });
  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.delete({ id: updated.id, revision: 2 }), {
    code: "context_pack_not_found"
  });
});

test("resolveSelection freezes only exact revisions in caller order", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const store = createStore(directory);
  const first = await store.create({ kind: "objective", name: "Goal", content: "Agree next steps." });
  const second = await store.create({
    kind: "product_facts",
    name: "Product",
    content: "Supports offline transcription."
  });
  const firstV2 = await store.update({
    id: first.id,
    revision: 1,
    content: "Agree owners and next steps."
  });

  const selected = await store.resolveSelection([
    { id: second.id, revision: second.revision },
    { id: firstV2.id, revision: firstV2.revision }
  ]);
  assert.deepEqual(selected.map(({ id }) => id), [second.id, first.id]);
  assert.equal(Object.isFrozen(selected), true);
  assert.equal(Object.isFrozen(selected[0]), true);
  assert.deepEqual(await store.getSelected([]), []);

  await assert.rejects(store.resolveSelection([{ id: first.id, revision: 1 }]), {
    code: "context_pack_revision_conflict"
  });
  await assert.rejects(store.resolveSelection([{ id: uuidFor(99), revision: 1 }]), {
    code: "context_pack_not_found"
  });
  await assert.rejects(store.resolveSelection([
    { id: first.id, revision: 2 },
    { id: first.id, revision: 2 }
  ]), { code: "invalid_context_selection" });
  await assert.rejects(store.resolveSelection([
    { id: first.id, revision: 2, content: "renderer injection" }
  ]), { code: "invalid_context_selection" });
});

test("closed input contracts reject unsafe, empty, unknown, and noncanonical values", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const store = createStore(directory);

  for (const invalid of [
    null,
    {},
    { kind: "objective", name: "Name" },
    { kind: "other", name: "Name", content: "Content" },
    { kind: "objective", name: " ", content: "Content" },
    { kind: "objective", name: "Unsafe\nname", content: "Content" },
    { kind: "objective", name: "Name", content: "\u0000unsafe" },
    { kind: "objective", name: "Name", content: "\ud800" },
    { kind: "objective", name: "Name", content: "Content", hidden: true }
  ]) {
    await assert.rejects(store.create(invalid), { code: "invalid_context_pack" });
  }

  const created = await store.create({ kind: "objective", name: "Name", content: "Content" });
  for (const invalid of [
    { id: created.id, revision: 1 },
    { id: created.id, revision: 1, unknown: "patch" },
    { id: "not-a-uuid", revision: 1, name: "New" },
    { id: created.id, revision: 0, name: "New" }
  ]) {
    await assert.rejects(store.update(invalid), { code: "invalid_context_pack" });
  }
});

test("character, per-item UTF-8, aggregate UTF-8, selection, and count limits fail before persistence", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const store = createStore(directory, { uuidFactory: createUuidFactory(100) });

  await assert.rejects(store.create({
    kind: "custom_notes",
    name: "x".repeat(CONTEXT_PACK_LIMITS.maxNameChars + 1),
    content: "Content"
  }), { code: "invalid_context_pack" });
  await assert.rejects(store.create({
    kind: "custom_notes",
    name: "Emoji bytes",
    content: "😀".repeat(Math.floor(CONTEXT_PACK_LIMITS.maxContentUtf8Bytes / 4) + 1)
  }), { code: "invalid_context_pack" });

  for (let index = 0; index < 8; index += 1) {
    await store.create({
      kind: "custom_notes",
      name: `Large ${index}`,
      content: String(index).repeat(30_000)
    });
  }
  const beforeAggregateFailure = await fs.readFile(path.join(directory, "context-packs.json"));
  await assert.rejects(store.create({
    kind: "custom_notes",
    name: "Aggregate overflow",
    content: "x".repeat(24_000)
  }), { code: "context_pack_limit_exceeded" });
  assert.deepEqual(await fs.readFile(path.join(directory, "context-packs.json")), beforeAggregateFailure);

  const selections = Array.from(
    { length: CONTEXT_PACK_LIMITS.maxSelectedItems + 1 },
    (_, index) => ({ id: uuidFor(500 + index), revision: 1 })
  );
  await assert.rejects(store.resolveSelection(selections), { code: "invalid_context_selection" });

  const countDirectory = await makeTemporaryDirectory(t);
  const countStore = createStore(countDirectory, { uuidFactory: createUuidFactory(1_000) });
  for (let index = 0; index < CONTEXT_PACK_LIMITS.maxItems; index += 1) {
    await countStore.create({ kind: "custom_notes", name: `Pack ${index}`, content: "Small" });
  }
  await assert.rejects(countStore.create({
    kind: "custom_notes",
    name: "One too many",
    content: "Small"
  }), { code: "context_pack_limit_exceeded" });
  assert.equal((await countStore.list()).length, CONTEXT_PACK_LIMITS.maxItems);
});

test("every operation fails closed when secure encryption is unavailable", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  let encryptCalls = 0;
  let decryptCalls = 0;
  const store = createStore(directory, {
    encryption: {
      async isEncryptionAvailable() { return false; },
      async encrypt() { encryptCalls += 1; return Buffer.from("must-not-write"); },
      async decrypt() { decryptCalls += 1; return "must-not-read"; }
    }
  });

  assert.equal(await store.encryptionAvailable(), false);
  for (const operation of [
    store.list(),
    store.create({ kind: "objective", name: "Goal", content: "Private" }),
    store.resolveSelection([])
  ]) {
    await assert.rejects(operation, { code: "secure_storage_unavailable" });
  }
  assert.equal(encryptCalls, 0);
  assert.equal(decryptCalls, 0);
  await assert.rejects(fs.access(path.join(directory, "context-packs.json")), { code: "ENOENT" });
});

test("unreadable storage and encryption failures are sanitized and never trigger replacement", async (t) => {
  const unreadableDirectory = await makeTemporaryDirectory(t);
  let writeCalls = 0;
  const unreadableStore = createStore(unreadableDirectory, {
    fileSystem: createFileSystemProxy({
      async open() {
        throw Object.assign(new Error("private path and operating-system details"), { code: "EACCES" });
      },
      async writeFile() {
        writeCalls += 1;
      }
    })
  });

  await assert.rejects(unreadableStore.list(), (error) => {
    assert.equal(error.code, "context_pack_read_failed");
    assert.equal(error.message.includes("private path"), false);
    return true;
  });
  await assert.rejects(unreadableStore.create({
    kind: "objective",
    name: "Replacement",
    content: "Must not write."
  }), { code: "context_pack_read_failed" });
  assert.equal(writeCalls, 0);

  const encryptionDirectory = await makeTemporaryDirectory(t);
  const encryptionStore = createStore(encryptionDirectory, {
    encryption: {
      async isEncryptionAvailable() { return true; },
      async encrypt() { throw new Error("private keychain details"); },
      async decrypt() { throw new Error("must not decrypt a missing file"); }
    }
  });
  await assert.rejects(encryptionStore.create({
    kind: "objective",
    name: "Goal",
    content: "Private"
  }), (error) => {
    assert.equal(error.code, "context_pack_encryption_failed");
    assert.equal(error.message.includes("keychain"), false);
    return true;
  });
  await assert.rejects(fs.access(path.join(encryptionDirectory, "context-packs.json")), { code: "ENOENT" });
});

test("corrupt, malformed, or undecryptable data is never treated as empty or overwritten", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const target = path.join(directory, "context-packs.json");
  const encryption = createFakeEncryption();
  const store = createStore(directory, { encryption });

  for (const serialized of [
    "{broken json",
    JSON.stringify({ schemaVersion: 1, ciphertext: "not base64!" }),
    JSON.stringify({ schemaVersion: 1, ciphertext: "YQ==", extra: true }),
    '{"schemaVersion":1,"schemaVersion":1,"ciphertext":"YQ=="}\n'
  ]) {
    await fs.writeFile(target, serialized, "utf8");
    const before = await fs.readFile(target);
    await assert.rejects(store.list(), { code: "context_pack_corrupt" });
    await assert.rejects(store.create({ kind: "objective", name: "Replacement", content: "No" }));
    assert.deepEqual(await fs.readFile(target), before);
  }

  await fs.writeFile(target, Buffer.alloc(CONTEXT_PACK_LIMITS.maxEncryptedFileBytes + 1, 0x61));
  const beforeOversized = await fs.readFile(target);
  await assert.rejects(store.create({ kind: "objective", name: "Replacement", content: "No" }), {
    code: "context_pack_corrupt"
  });
  assert.deepEqual(await fs.readFile(target), beforeOversized);

  const corruptPlaintext = encryption.wrapPlaintext(JSON.stringify({ schemaVersion: 1, items: "wrong" }));
  await fs.writeFile(target, corruptPlaintext, "utf8");
  const beforePlaintext = await fs.readFile(target);
  await assert.rejects(store.create({ kind: "objective", name: "Replacement", content: "No" }), {
    code: "context_pack_corrupt"
  });
  assert.deepEqual(await fs.readFile(target), beforePlaintext);

  const duplicatePlaintext = encryption.wrapPlaintext(
    '{"schemaVersion":1,"schemaVersion":1,"items":[]}\n'
  );
  await fs.writeFile(target, duplicatePlaintext, "utf8");
  const beforeDuplicate = await fs.readFile(target);
  await assert.rejects(store.create({ kind: "objective", name: "Replacement", content: "No" }), {
    code: "context_pack_corrupt"
  });
  assert.deepEqual(await fs.readFile(target), beforeDuplicate);

  const decryptingStore = createStore(directory, {
    encryption: {
      async isEncryptionAvailable() { return true; },
      async encrypt() { throw new Error("must not overwrite"); },
      async decrypt() { throw new Error("private OS details"); }
    }
  });
  await assert.rejects(decryptingStore.list(), (error) => {
    assert.equal(error.code, "context_pack_decryption_failed");
    assert.equal(error.message.includes("private OS details"), false);
    return true;
  });
  assert.deepEqual(await fs.readFile(target), beforeDuplicate);
});

test("concurrent mutations are serialized without lost updates", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const encryption = createFakeEncryption({ yieldDuringEncrypt: true });
  const store = createStore(directory, {
    encryption,
    uuidFactory: createUuidFactory(2_000)
  });

  const created = await Promise.all(Array.from({ length: 12 }, (_, index) => store.create({
    kind: "custom_notes",
    name: `Concurrent ${index}`,
    content: `Value ${index}`
  })));

  assert.equal(created.length, 12);
  assert.equal(new Set(created.map(({ id }) => id)).size, 12);
  assert.equal((await store.list()).length, 12);
  assert.equal(encryption.maxActiveEncryptions, 1);
});

test("Electron-style shouldReEncrypt results rotate ciphertext through the same atomic path", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const encryption = createFakeEncryption({ shouldReEncryptOnce: true });
  const store = createStore(directory, { encryption });
  const created = await store.create({ kind: "resume", name: "Resume", content: "Built local apps." });
  const target = path.join(directory, "context-packs.json");
  const before = await fs.readFile(target, "utf8");

  assert.deepEqual(await store.list(), [created]);
  const after = await fs.readFile(target, "utf8");
  assert.notEqual(after, before);
  assert.equal(encryption.encryptCalls, 2);
  assert.equal(encryption.decryptCalls, 1);
  assert.deepEqual(await fs.readdir(directory), ["context-packs.json"]);
});

test("failed atomic replacement removes its encrypted temporary artifact", async (t) => {
  const directory = await makeTemporaryDirectory(t);
  const fileSystem = createFileSystemProxy({
    async rename() {
      throw new Error("simulated replacement failure with private path");
    }
  });
  const store = createStore(directory, { fileSystem });

  await assert.rejects(store.create({ kind: "objective", name: "Goal", content: "Private" }), (error) => {
    assert.equal(error instanceof ContextPackStoreError, true);
    assert.equal(error.code, "context_pack_write_failed");
    assert.equal(error.message.includes("private path"), false);
    return true;
  });
  assert.deepEqual(await fs.readdir(directory), []);
});

test("invalid or repeatedly colliding UUID factories never persist renderer-controlled identifiers", async (t) => {
  const invalidDirectory = await makeTemporaryDirectory(t);
  const invalidStore = createStore(invalidDirectory, { uuidFactory: () => "renderer-id" });
  await assert.rejects(invalidStore.create({ kind: "objective", name: "Goal", content: "Text" }), {
    code: "context_pack_id_failed"
  });
  await assert.rejects(fs.access(path.join(invalidDirectory, "context-packs.json")), { code: "ENOENT" });

  const collisionDirectory = await makeTemporaryDirectory(t);
  const collisionStore = createStore(collisionDirectory, { uuidFactory: () => uuidFor(1) });
  await collisionStore.create({ kind: "objective", name: "First", content: "Text" });
  await assert.rejects(collisionStore.create({ kind: "objective", name: "Second", content: "Text" }), {
    code: "context_pack_id_failed"
  });
  assert.equal((await collisionStore.list()).length, 1);
});

function createStore(directory, {
  encryption = createFakeEncryption(),
  fileSystem = fs,
  uuidFactory = createUuidFactory(1)
} = {}) {
  return createContextPackStore({
    contextPackPath: path.join(directory, "context-packs.json"),
    encrypt: encryption.encrypt.bind(encryption),
    decrypt: encryption.decrypt.bind(encryption),
    isEncryptionAvailable: encryption.isEncryptionAvailable.bind(encryption),
    fileSystem,
    uuidFactory
  });
}

function createFakeEncryption({ shouldReEncryptOnce = false, yieldDuringEncrypt = false } = {}) {
  let generation = 0;
  let rotate = shouldReEncryptOnce;
  const plaintextByToken = new Map();
  return {
    encryptCalls: 0,
    decryptCalls: 0,
    activeEncryptions: 0,
    maxActiveEncryptions: 0,
    async isEncryptionAvailable() {
      return true;
    },
    async encrypt(plaintext) {
      this.encryptCalls += 1;
      this.activeEncryptions += 1;
      this.maxActiveEncryptions = Math.max(this.maxActiveEncryptions, this.activeEncryptions);
      if (yieldDuringEncrypt) await new Promise((resolve) => setImmediate(resolve));
      const token = `cipher-${++generation}`;
      plaintextByToken.set(token, plaintext);
      this.activeEncryptions -= 1;
      return Buffer.from(token, "utf8");
    },
    async decrypt(ciphertext) {
      this.decryptCalls += 1;
      const token = ciphertext.toString("utf8");
      const plaintext = plaintextByToken.get(token);
      if (plaintext === undefined) throw new Error("unknown ciphertext");
      const shouldReEncrypt = rotate;
      rotate = false;
      return { result: plaintext, shouldReEncrypt };
    },
    wrapPlaintext(plaintext) {
      const token = `cipher-${++generation}`;
      plaintextByToken.set(token, plaintext);
      return `${JSON.stringify({
        schemaVersion: CONTEXT_PACK_SCHEMA_VERSION,
        ciphertext: Buffer.from(token, "utf8").toString("base64")
      })}\n`;
    }
  };
}

function createUuidFactory(start) {
  let value = start;
  return () => uuidFor(value++);
}

function uuidFor(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function createFileSystemProxy(overrides = {}) {
  return {
    open: overrides.open ?? fs.open.bind(fs),
    mkdir: overrides.mkdir ?? fs.mkdir.bind(fs),
    writeFile: overrides.writeFile ?? fs.writeFile.bind(fs),
    rename: overrides.rename ?? fs.rename.bind(fs),
    unlink: overrides.unlink ?? fs.unlink.bind(fs)
  };
}

async function makeTemporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-context-pack-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
