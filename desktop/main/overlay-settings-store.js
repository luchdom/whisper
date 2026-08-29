import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_OVERLAY_SETTINGS,
  createPersistedOverlaySettings,
  sanitizeStoredOverlaySettings,
  validateOverlaySettingsPatch
} from "./overlay-policy.js";

export function createOverlaySettingsStore({
  userDataPath,
  fileName = "overlay-settings.json",
  fileSystem = fs
} = {}) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new TypeError("userDataPath must be an absolute path.");
  }
  if (typeof fileName !== "string" || fileName.length === 0 || path.basename(fileName) !== fileName) {
    throw new TypeError("fileName must be a plain file name.");
  }
  assertFileSystem(fileSystem);

  const filePath = path.join(userDataPath, fileName);
  let pendingWrite = Promise.resolve();

  async function load() {
    let serialized;
    try {
      serialized = await fileSystem.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return cloneDefaults();
      throw error;
    }

    try {
      return sanitizeStoredOverlaySettings(JSON.parse(serialized));
    } catch (error) {
      if (error instanceof SyntaxError) return cloneDefaults();
      throw error;
    }
  }

  async function save(value) {
    const persisted = createPersistedOverlaySettings(value);
    return enqueue(async () => {
      await fileSystem.mkdir(userDataPath, { recursive: true });
      const temporaryPath = path.join(
        userDataPath,
        `.${fileName}.${process.pid}.${randomUUID()}.tmp`
      );

      try {
        await fileSystem.writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600
        });
        await fileSystem.rename(temporaryPath, filePath);
      } finally {
        await fileSystem.unlink(temporaryPath).catch(() => {});
      }
      return persisted;
    });
  }

  async function update(patch) {
    const validatedPatch = validateOverlaySettingsPatch(patch);
    return enqueue(async () => {
      const current = await load();

      // Opacity is a private-mode affordance. Rejecting an opacity-only patch
      // while accessible mode is effective prevents a stale renderer from
      // creating an internally contradictory persisted preference.
      if (current.mode === "accessible"
        && !("mode" in validatedPatch)
        && "opacity" in validatedPatch
        && validatedPatch.opacity !== 1) {
        throw new TypeError("Accessible overlay mode must remain fully opaque.");
      }

      const next = {
        ...current,
        ...validatedPatch
      };
      if (next.mode === "accessible") next.opacity = 1;
      return writeAtomic(createPersistedOverlaySettings(next));
    });
  }

  async function writeAtomic(persisted) {
    await fileSystem.mkdir(userDataPath, { recursive: true });
    const temporaryPath = path.join(
      userDataPath,
      `.${fileName}.${process.pid}.${randomUUID()}.tmp`
    );
    try {
      await fileSystem.writeFile(temporaryPath, `${JSON.stringify(persisted, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600
      });
      await fileSystem.rename(temporaryPath, filePath);
    } finally {
      await fileSystem.unlink(temporaryPath).catch(() => {});
    }
    return persisted;
  }

  function enqueue(operation) {
    const result = pendingWrite.then(operation, operation);
    pendingWrite = result.then(() => undefined, () => undefined);
    return result;
  }

  return Object.freeze({ filePath, load, save, update });
}

function cloneDefaults() {
  return createPersistedOverlaySettings(DEFAULT_OVERLAY_SETTINGS);
}

function assertFileSystem(value) {
  for (const method of ["readFile", "mkdir", "writeFile", "rename", "unlink"]) {
    if (typeof value?.[method] !== "function") {
      throw new TypeError(`fileSystem.${method} is required.`);
    }
  }
}
