import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const smokeUrl = new URL("../tools/windows-safe-storage-smoke.mjs", import.meta.url);
const smokePath = fileURLToPath(smokeUrl);

test("Windows safe-storage smoke has a closed aggregate-only cross-platform contract", async () => {
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    smokePath,
    "--contract-only"
  ], {
    encoding: "utf8",
    windowsHide: true
  });

  assert.equal(stderr, "");
  const report = JSON.parse(stdout);
  assert.deepEqual(Object.keys(report).sort(), [
    "mode",
    "passed",
    "probe",
    "requirements",
    "schemaVersion"
  ]);
  assert.deepEqual(report, {
    schemaVersion: 1,
    probe: "windows_safe_storage",
    mode: "contract_only",
    passed: true,
    requirements: {
      aggregateOnly: true,
      cleanupRequired: true,
      electronRuntimeRequired: true,
      isolatedStorageRequired: true,
      windowsHostRequired: true
    }
  });
  assert.doesNotMatch(stdout, /sk-|Synthetic|canary|[A-Za-z]:\\|provider-credential\.json/i);
});

test("runtime smoke exercises both production stores through real Electron safeStorage", async () => {
  const source = await readFile(smokeUrl, "utf8");

  assert.match(source, /createProviderCredentialStore/);
  assert.match(source, /createContextPackStore/);
  assert.match(source, /await import\("electron"\)/);
  assert.match(source, /safeStorage\.isAsyncEncryptionAvailable\(\)/);
  assert.match(source, /safeStorage\.encryptStringAsync\(plaintext\)/);
  assert.match(source, /safeStorage\.decryptStringAsync\(ciphertext\)/);
  assert.match(source, /safeStorage\.isEncryptionAvailable\(\)/);
  assert.match(source, /safeStorage\.encryptString\(plaintext\)/);
  assert.match(source, /safeStorage\.decryptString\(ciphertext\)/);
  assert.match(source, /fs\.mkdtemp\(path\.join\(os\.tmpdir\(\)/);
  assert.match(source, /createProviderCredentialStore\(\{ credentialPath/);
  assert.match(source, /createContextPackStore\(\{/);
  assert.match(source, /fs\.rm\(isolatedDirectory, \{ recursive: true, force: true/);
  assert.match(source, /bufferContainsAnyCanary/);
  assert.match(source, /electronApp\.exit\(result\.passed \? 0 : 1\)/);
  assert.doesNotMatch(source, /console\.(?:log|error)\([^)]*error/i);
});
