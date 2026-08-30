import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executableName = process.platform === "win32"
  ? "meeting-transcriber-sidecar.exe"
  : "meeting-transcriber-sidecar";
const sidecarDirectory = path.join(repositoryRoot, "build", "sidecar", "meeting-transcriber-sidecar");
const expected = [
  path.join(sidecarDirectory, executableName),
  path.join(repositoryRoot, "build", "compliance", "runtime-inventory.json"),
  path.join(repositoryRoot, "build", "compliance", "SBOM.cdx.json"),
  path.join(repositoryRoot, "THIRD_PARTY_NOTICES.md")
];
for (const candidate of expected) {
  if (!existsSync(candidate)) throw new Error(`Missing distribution input: ${path.basename(candidate)}`);
}
const inventory = JSON.parse(readFileSync(expected[1], "utf8"));
const bom = JSON.parse(readFileSync(expected[2], "utf8"));
verifyInventory(inventory, sidecarDirectory);
verifyBom(bom, inventory);
const probe = spawnSync(expected[0], ["--setup-probe"], {
  cwd: repositoryRoot,
  encoding: "utf8",
  env: {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    PYTHONHOME: "ignored-by-standalone-smoke",
    PYTHONPATH: "ignored-by-standalone-smoke"
  },
  timeout: 60_000,
  windowsHide: true,
  shell: false
});
if (probe.status !== 0 || !probe.stdout.includes("__MEETING_TRANSCRIBER_SETUP_V1__")) {
  throw new Error("The standalone runtime probe failed.");
}
if (process.argv.includes("--packaged")) verifyPackagedResources();
process.stdout.write("Standalone runtime inventory, SBOM, and notices verified.\n");

function verifyPackagedResources() {
  const distributionRoot = path.join(repositoryRoot, "dist");
  if (!existsSync(distributionRoot)) throw new Error("The packaged app output is missing.");
  const packagedSidecars = findFiles(distributionRoot, (candidate) => (
    path.basename(candidate) === executableName
    && candidate.replaceAll("\\", "/").includes("/resources/sidecar/")
  ));
  const packagedSboms = findFiles(distributionRoot, (candidate) => (
    path.basename(candidate) === "SBOM.cdx.json"
    && candidate.replaceAll("\\", "/").includes("/resources/")
  ));
  if (packagedSidecars.length === 0 || packagedSboms.length === 0) {
    throw new Error("The packaged app is missing its standalone runtime or SBOM.");
  }
  const packagedProbe = spawnSync(packagedSidecars[0], ["--setup-probe"], {
    cwd: path.dirname(packagedSidecars[0]),
    encoding: "utf8",
    env: { PATH: "", SystemRoot: process.env.SystemRoot },
    timeout: 60_000,
    windowsHide: true,
    shell: false
  });
  if (packagedProbe.status !== 0 || !packagedProbe.stdout.includes("__MEETING_TRANSCRIBER_SETUP_V1__")) {
    throw new Error("The packaged standalone runtime probe failed.");
  }
  verifyBom(JSON.parse(readFileSync(packagedSboms[0], "utf8")), inventory);
}

function verifyInventory(value, runtimeRoot) {
  if (
    value?.schemaVersion !== 1
    || value?.inventoryKind !== "observed-packaged-runtime"
    || !Array.isArray(value.packagedRuntime?.pythonPackages)
    || value.packagedRuntime.pythonPackages.length === 0
  ) {
    throw new Error("The packaged runtime inventory is missing or invalid.");
  }
  const cpython = value.packagedRuntime.cpython;
  if (cpython?.name !== "CPython" || !/^3\.12\.\d+$/.test(cpython.version)) {
    throw new Error("The packaged runtime inventory is missing CPython 3.12.");
  }
  const evidencePath = path.resolve(runtimeRoot, cpython.evidencePath ?? "");
  const relativeEvidencePath = path.relative(runtimeRoot, evidencePath);
  if (
    !relativeEvidencePath
    || relativeEvidencePath.startsWith("..")
    || path.isAbsolute(relativeEvidencePath)
    || !existsSync(evidencePath)
  ) {
    throw new Error("The packaged runtime inventory has invalid CPython evidence.");
  }
  const runtimeNames = new Set(
    value.packagedRuntime.pythonPackages.map(({ canonicalName }) => canonicalName)
  );
  const buildNames = new Set(
    (value.buildEnvironment?.tools ?? []).map(({ canonicalName }) => canonicalName)
  );
  if (runtimeNames.has("pyinstaller") || !buildNames.has("pyinstaller")) {
    throw new Error("The packaged runtime inventory does not separate PyInstaller build tooling.");
  }
}

function verifyBom(value, sourceInventory) {
  if (value?.bomFormat !== "CycloneDX" || value?.specVersion !== "1.6" || !value.components?.length) {
    throw new Error("The release SBOM is missing or invalid.");
  }
  const applicationRef = value.metadata?.component?.["bom-ref"];
  const applicationDependency = value.dependencies?.find(({ ref }) => ref === applicationRef);
  const requiredReferences = new Set(applicationDependency?.dependsOn ?? []);
  const cpythonReference = `pkg:generic/cpython@${sourceInventory.packagedRuntime.cpython.version}`;
  if (!requiredReferences.has(cpythonReference)) {
    throw new Error("The release SBOM does not identify embedded CPython as required runtime.");
  }
  const buildToolNames = new Set(
    (value.metadata?.tools?.components ?? []).map(({ name }) => normalizeName(name))
  );
  if (!buildToolNames.has("pyinstaller")) {
    throw new Error("The release SBOM does not identify PyInstaller as build tooling.");
  }
  const forbiddenRequiredNames = new Set(
    (sourceInventory.buildEnvironment?.tools ?? []).map(({ canonicalName }) => canonicalName)
  );
  for (const component of value.components) {
    if (component.scope === "required" && forbiddenRequiredNames.has(normalizeName(component.name))) {
      throw new Error(`Build tool is incorrectly required at runtime: ${component.name}.`);
    }
  }
}

function normalizeName(value) {
  return String(value).toLowerCase().replace(/[._]+/g, "-");
}

function findFiles(root, predicate) {
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      matches.push(...findFiles(candidate, predicate));
    } else if (entry.isFile() && statSync(candidate).size >= 0 && predicate(candidate)) {
      matches.push(candidate);
    }
  }
  return matches;
}
