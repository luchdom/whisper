import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageMetadata = JSON.parse(readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
const inventoryPath = path.join(repositoryRoot, "build", "compliance", "runtime-inventory.json");
if (!existsSync(inventoryPath)) {
  throw new Error("Build the standalone sidecar before generating its SBOM.");
}
const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
validateInventory(inventory);

const electronVersion = packageMetadata.devDependencies.electron;
const cpython = inventory.packagedRuntime.cpython;
const runtimeComponents = [
  {
    type: "framework",
    "bom-ref": `pkg:npm/electron@${electronVersion}`,
    group: "npm",
    name: "electron",
    version: electronVersion,
    purl: `pkg:npm/electron@${electronVersion}`,
    scope: "required"
  },
  {
    type: "application",
    "bom-ref": `pkg:generic/cpython@${cpython.version}`,
    group: "python.org",
    name: cpython.name,
    version: cpython.version,
    purl: `pkg:generic/cpython@${cpython.version}`,
    scope: "required",
    properties: [{ name: "luchdom:evidence:path", value: cpython.evidencePath }]
  },
  ...inventory.packagedRuntime.pythonPackages.map(pythonRuntimeComponent)
].sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));

const buildTools = inventory.buildEnvironment.tools.map(({ name, version, canonicalName }) => ({
  type: "application",
  "bom-ref": `pkg:pypi/${canonicalName}@${version}?luchdom_scope=build`,
  group: "pypi",
  name,
  version,
  purl: `pkg:pypi/${canonicalName}@${version}`
})).sort((left, right) => left["bom-ref"].localeCompare(right["bom-ref"]));

const applicationRef = `pkg:generic/${packageMetadata.name}@${packageMetadata.version}`;
const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    component: {
      type: "application",
      "bom-ref": applicationRef,
      name: packageMetadata.name,
      version: packageMetadata.version
    },
    tools: { components: buildTools },
    properties: [
      { name: "luchdom:target:platform", value: inventory.target.platform },
      { name: "luchdom:target:arch", value: inventory.target.arch },
      { name: "luchdom:models:bundled", value: "false" },
      { name: "luchdom:inventory:basis", value: "observed-packaged-runtime" },
      {
        name: "luchdom:inventory:limitation",
        value: "Transitive Python versions are platform-resolved build inputs, not an immutable repository lock."
      }
    ]
  },
  components: runtimeComponents,
  dependencies: [{
    ref: applicationRef,
    dependsOn: runtimeComponents.map(({ "bom-ref": reference }) => reference)
  }]
};
const outputDirectory = path.dirname(inventoryPath);
mkdirSync(outputDirectory, { recursive: true });
writeFileSync(
  path.join(outputDirectory, "SBOM.cdx.json"),
  `${JSON.stringify(bom, null, 2)}\n`,
  "utf8"
);

function pythonRuntimeComponent({ name, canonicalName, version, sourceKind, evidence }) {
  const purl = sourceKind === "pypi"
    ? `pkg:pypi/${canonicalName}@${version}`
    : `pkg:generic/${canonicalName}@${version}`;
  return {
    type: "library",
    "bom-ref": purl,
    group: sourceKind === "pypi" ? "pypi" : "local",
    name,
    version,
    purl,
    scope: "required",
    properties: [{ name: "luchdom:evidence", value: evidence }]
  };
}

function validateInventory(value) {
  if (value?.schemaVersion !== 1 || value?.inventoryKind !== "observed-packaged-runtime") {
    throw new Error("The standalone runtime inventory is missing or invalid.");
  }
  if (!value.target?.platform || !value.target?.arch) {
    throw new Error("The standalone runtime inventory has no target identity.");
  }
  if (
    value.packagedRuntime?.cpython?.name !== "CPython"
    || !/^3\.12\.\d+$/.test(value.packagedRuntime.cpython.version)
    || !value.packagedRuntime.cpython.evidencePath
  ) {
    throw new Error("The standalone runtime inventory has no verified CPython 3.12 component.");
  }
  if (!Array.isArray(value.packagedRuntime.pythonPackages) || value.packagedRuntime.pythonPackages.length === 0) {
    throw new Error("The standalone runtime inventory contains no observed Python packages.");
  }
  if (!Array.isArray(value.buildEnvironment?.tools)) {
    throw new Error("The standalone runtime inventory does not separate build tools.");
  }
  const buildNames = new Set(value.buildEnvironment.tools.map(({ canonicalName }) => canonicalName));
  const runtimeNames = new Set(value.packagedRuntime.pythonPackages.map(({ canonicalName }) => canonicalName));
  if (!buildNames.has("pyinstaller") || runtimeNames.has("pyinstaller")) {
    throw new Error("PyInstaller must be recorded as build tooling, not a required runtime package.");
  }
}
