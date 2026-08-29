import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_OVERLAY_SETTINGS } from "../main/overlay-policy.js";
import { createOverlaySettingsStore } from "../main/overlay-settings-store.js";

test("overlay settings default to an overt, opaque accessible presentation", async (context) => {
  const directory = await createTemporaryDirectory(context);
  const store = createOverlaySettingsStore({ userDataPath: directory });

  assert.deepEqual(await store.load(), DEFAULT_OVERLAY_SETTINGS);
});

test("overlay settings persist only the versioned policy schema with an atomic write", async (context) => {
  const directory = await createTemporaryDirectory(context);
  const store = createOverlaySettingsStore({ userDataPath: directory });
  const saved = await store.save({
    mode: "private",
    opacity: 0.72,
    bounds: { x: -1200, y: 80, width: 560, height: 360 },
    displayId: 9,
    clickThrough: true,
    credentials: "must-not-persist"
  });

  assert.deepEqual(saved, {
    version: 1,
    mode: "private",
    opacity: 0.72,
    bounds: { x: -1200, y: 80, width: 560, height: 360 },
    displayId: 9
  });
  assert.deepEqual(JSON.parse(await readFile(store.filePath, "utf8")), saved);
  assert.deepEqual(await store.load(), saved);
});

test("effective accessible mode rejects an opacity-only patch and normalizes mode changes", async (context) => {
  const directory = await createTemporaryDirectory(context);
  const store = createOverlaySettingsStore({ userDataPath: directory });

  await assert.rejects(
    store.update({ opacity: 0.8 }),
    /Accessible overlay mode must remain fully opaque/
  );

  assert.equal((await store.update({ mode: "private", opacity: 0.8 })).opacity, 0.8);
  assert.deepEqual(await store.update({ mode: "accessible" }), {
    version: 1,
    mode: "accessible",
    opacity: 1,
    bounds: null,
    displayId: null
  });
});

test("concurrent updates serialize without dropping a completed preference", async (context) => {
  const directory = await createTemporaryDirectory(context);
  const store = createOverlaySettingsStore({ userDataPath: directory });
  await store.update({ mode: "private" });

  await Promise.all([
    store.update({ opacity: 0.65 }),
    store.update({ bounds: { x: 10, y: 20, width: 600, height: 400 }, displayId: 3 })
  ]);

  assert.deepEqual(await store.load(), {
    version: 1,
    mode: "private",
    opacity: 0.65,
    bounds: { x: 10, y: 20, width: 600, height: 400 },
    displayId: 3
  });
});

test("malformed or out-of-schema files fail safe to accessible defaults", async (context) => {
  const directory = await createTemporaryDirectory(context);
  const store = createOverlaySettingsStore({ userDataPath: directory });

  await writeFile(store.filePath, "{broken", "utf8");
  assert.deepEqual(await store.load(), DEFAULT_OVERLAY_SETTINGS);
  await writeFile(store.filePath, JSON.stringify({ ...DEFAULT_OVERLAY_SETTINGS, clickThrough: true }), "utf8");
  assert.deepEqual(await store.load(), DEFAULT_OVERLAY_SETTINGS);
});

test("store dependencies reject unsafe paths and incomplete file systems", () => {
  assert.throws(() => createOverlaySettingsStore({ userDataPath: "relative" }), /absolute/);
  assert.throws(
    () => createOverlaySettingsStore({ userDataPath: path.resolve("."), fileName: "../escape.json" }),
    /plain file name/
  );
  assert.throws(
    () => createOverlaySettingsStore({ userDataPath: path.resolve("."), fileSystem: {} }),
    /fileSystem\.readFile/
  );
});

async function createTemporaryDirectory(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "whisper-overlay-settings-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
