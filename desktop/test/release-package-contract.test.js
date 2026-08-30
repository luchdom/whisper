import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSigningCredentials,
  collectSignatureTargets
} from "../../scripts/verify-signatures.mjs";

const repositoryUrl = new URL("../../", import.meta.url);

test("desktop packages the standalone runtime, SBOM, and notices", async () => {
  const packageMetadata = JSON.parse(await readFile(new URL("package.json", repositoryUrl), "utf8"));
  const resources = packageMetadata.build.extraResources;

  assert.equal(packageMetadata.version, "0.9.0");
  assert.equal(
    resources.some(({ from, to }) => (
      from === "build/sidecar/meeting-transcriber-sidecar" && to === "sidecar"
    )),
    true
  );
  assert.equal(
    resources.some(({ from, to }) => (
      from === "build/compliance/SBOM.cdx.json" && to === "SBOM.cdx.json"
    )),
    true
  );
  assert.equal(
    resources.some(({ from, to }) => (
      from === "THIRD_PARTY_NOTICES.md" && to === "THIRD_PARTY_NOTICES.md"
    )),
    true
  );
  assert.match(packageMetadata.scripts.pack, /prepare:distribution/);
  assert.match(packageMetadata.scripts.pack, /--packaged/);
  assert.match(packageMetadata.scripts["dist:signed"], /^pnpm run preflight:signing/);
  assert.match(packageMetadata.scripts["dist:signed"], /electron-builder\.release\.cjs/);
  assert.match(packageMetadata.scripts["dist:signed"], /pnpm run verify:signatures$/);
  assert.deepEqual(packageMetadata.build.win.signExts, [".exe", ".dll", ".pyd"]);
});

test("release packaging fails closed on signing and requests macOS notarization", async () => {
  const releaseConfig = await readFile(
    new URL("electron-builder.release.cjs", repositoryUrl),
    "utf8"
  );
  const signedWorkflow = await readFile(
    new URL(".github/workflows/signed-release.yml", repositoryUrl),
    "utf8"
  );

  assert.match(releaseConfig, /forceCodeSigning:\s*true/);
  assert.match(releaseConfig, /notarize:\s*true/);
  assert.match(releaseConfig, /signAndEditExecutable:\s*true/);
  assert.match(signedWorkflow, /workflow_dispatch:/);
  assert.match(signedWorkflow, /Get-AuthenticodeSignature/);
  assert.match(signedWorkflow, /codesign --verify --deep --strict/);
  assert.match(signedWorkflow, /xcrun stapler validate/);
  assert.doesNotMatch(signedWorkflow, /gh release|create-release|release-action/i);
});

test("signed-build credential preflight is host-specific and fail-closed", () => {
  assert.throws(
    () => assertSigningCredentials({ platform: "win32", environment: {} }),
    /Windows Authenticode credentials are missing/
  );
  assert.deepEqual(
    assertSigningCredentials({
      platform: "win32",
      environment: {
        WIN_CSC_LINK: "private-certificate",
        WIN_CSC_KEY_PASSWORD: "private-password",
        APPLE_ID: "irrelevant-partial-mac-credential"
      }
    }),
    { platform: "win32", signingMethod: "WIN_CSC_LINK" }
  );
  assert.deepEqual(
    assertSigningCredentials({
      platform: "darwin",
      environment: {
        CSC_LINK: "private-certificate",
        CSC_KEY_PASSWORD: "private-password",
        APPLE_API_KEY: "private-api-key",
        APPLE_API_KEY_ID: "private-key-id",
        APPLE_API_ISSUER: "private-issuer",
        WIN_CSC_LINK: "irrelevant-partial-windows-credential"
      }
    }),
    {
      platform: "darwin",
      signingMethod: "CSC_LINK",
      notarizationMethod: "app-store-connect-api-key"
    }
  );
  assert.throws(
    () => assertSigningCredentials({
      platform: "darwin",
      environment: {
        CSC_LINK: "private-certificate",
        CSC_KEY_PASSWORD: "private-password",
        APPLE_ID: "private-apple-id"
      }
    }),
    /notarization credentials are incomplete/
  );
  assert.throws(
    () => assertSigningCredentials({ platform: "linux", environment: {} }),
    /supported only on Windows and macOS/
  );
});

test("signature verification targets every Windows native binary and the outer macOS app", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "meeting-transcriber-signatures-"));
  try {
    const appDirectory = path.join(temporaryDirectory, "mac-arm64", "Meeting Transcriber.app");
    await mkdir(path.join(appDirectory, "Contents", "MacOS"), { recursive: true });
    const helperAppDirectory = path.join(
      appDirectory,
      "Contents",
      "Frameworks",
      "Meeting Transcriber Helper.app",
      "Contents",
      "MacOS"
    );
    await mkdir(helperAppDirectory, { recursive: true });
    await mkdir(path.join(temporaryDirectory, "win-unpacked", "resources"), { recursive: true });
    await writeFile(path.join(appDirectory, "Contents", "MacOS", "Meeting Transcriber"), "fixture");
    await writeFile(path.join(helperAppDirectory, "Meeting Transcriber Helper"), "fixture");
    await writeFile(path.join(temporaryDirectory, "Meeting Transcriber.dmg"), "fixture");
    await writeFile(path.join(temporaryDirectory, "win-unpacked", "Meeting Transcriber.exe"), "fixture");
    await writeFile(path.join(temporaryDirectory, "win-unpacked", "resources", "runtime.dll"), "fixture");
    await writeFile(path.join(temporaryDirectory, "win-unpacked", "resources", "extension.pyd"), "fixture");
    await writeFile(path.join(temporaryDirectory, "win-unpacked", "resources", "ignored.txt"), "fixture");

    const windowsTargets = await collectSignatureTargets({
      platform: "win32",
      distDirectory: temporaryDirectory
    });
    assert.deepEqual(
      windowsTargets.map((target) => path.extname(target).toLowerCase()).sort(),
      [".dll", ".exe", ".pyd"]
    );

    const macTargets = await collectSignatureTargets({
      platform: "darwin",
      distDirectory: temporaryDirectory
    });
    assert.deepEqual(macTargets.map((target) => path.basename(target)), ["Meeting Transcriber.app"]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the distribution build tools and CI Python patch are exact", async () => {
  const buildRequirements = await readFile(
    new URL("backend/packaging/requirements-build.txt", repositoryUrl),
    "utf8"
  );
  const validateWorkflow = await readFile(
    new URL(".github/workflows/validate.yml", repositoryUrl),
    "utf8"
  );

  assert.match(buildRequirements, /^pyinstaller==6\.22\.2$/m);
  assert.match(buildRequirements, /^pyinstaller-hooks-contrib==2026\.7$/m);
  assert.match(validateWorkflow, /python-version:\s*3\.12\.10/);
  assert.match(validateWorkflow, /runner:\s*windows-2025/);
  assert.match(validateWorkflow, /runner:\s*macos-15/);
});

test("the SBOM separates observed runtime components from build tooling", async () => {
  const buildScript = await readFile(
    new URL("scripts/build-sidecar.mjs", repositoryUrl),
    "utf8"
  );
  const inspectionScript = await readFile(
    new URL("scripts/inspect-python-runtime.py", repositoryUrl),
    "utf8"
  );
  const sbomScript = await readFile(
    new URL("scripts/generate-sbom.mjs", repositoryUrl),
    "utf8"
  );
  const verifier = await readFile(
    new URL("scripts/verify-distribution.mjs", repositoryUrl),
    "utf8"
  );

  assert.match(buildScript, /inventoryKind:\s*"observed-packaged-runtime"/);
  assert.match(buildScript, /findEmbeddedPythonRuntime/);
  assert.match(inspectionScript, /BUILD_ENVIRONMENT_TOOLS/);
  assert.match(inspectionScript, /"pyinstaller"/);
  assert.match(sbomScript, /metadata:[\s\S]*tools:\s*\{ components: buildTools \}/);
  assert.match(sbomScript, /pkg:generic\/cpython@/);
  assert.doesNotMatch(sbomScript, /python-packages\.json/);
  assert.match(verifier, /runtimeNames\.has\("pyinstaller"\)/);
  assert.match(verifier, /does not identify embedded CPython as required runtime/);
});
