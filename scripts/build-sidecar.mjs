import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");
const backendRoot = path.join(repositoryRoot, "backend");
const buildRoot = path.join(repositoryRoot, "build");
const sidecarRoot = path.join(buildRoot, "sidecar");
const pyinstallerRoot = path.join(buildRoot, "pyinstaller");
const complianceRoot = path.join(buildRoot, "compliance");
const executableName = process.platform === "win32"
  ? "meeting-transcriber-sidecar.exe"
  : "meeting-transcriber-sidecar";
const executablePath = path.join(
  sidecarRoot,
  "meeting-transcriber-sidecar",
  executableName
);
const sentinel = "__MEETING_TRANSCRIBER_SETUP_V1__";
const inventoryPath = path.join(complianceRoot, "runtime-inventory.json");

const python = resolvePython();
const version = readPythonVersion(python);
const requiredPatch = process.env.MEETING_TRANSCRIBER_REQUIRE_PYTHON_PATCH?.trim();
if (requiredPatch && version.version !== requiredPatch) {
  fail(`The release build requires CPython ${requiredPatch}; found ${version.version}.`);
}

runPython(python, [
  "-m",
  "pip",
  "install",
  "--disable-pip-version-check",
  "--requirement",
  path.join(backendRoot, "packaging", "requirements-build.txt")
]);

mkdirSync(sidecarRoot, { recursive: true });
mkdirSync(pyinstallerRoot, { recursive: true });
mkdirSync(complianceRoot, { recursive: true });

const collectDataPackages = [
  "faster_whisper",
  "meeting_transcriber"
];
const collectBinaryPackages = [
  "ctranslate2",
  "onnxruntime",
  "sentencepiece",
  "sherpa_onnx",
  "tokenizers"
];
const hiddenImports = [
  "ctranslate2",
  "faster_whisper",
  "huggingface_hub",
  "sentencepiece",
  "sherpa_onnx"
];
const metadataPackages = [
  "av",
  "ctranslate2",
  "faster-whisper",
  "huggingface-hub",
  "onnxruntime",
  "sentencepiece",
  "sherpa-onnx",
  "tokenizers"
];
const pyinstallerArguments = [
  "-m",
  "PyInstaller",
  "--noconfirm",
  "--clean",
  "--onedir",
  "--console",
  "--noupx",
  "--name",
  "meeting-transcriber-sidecar",
  "--distpath",
  sidecarRoot,
  "--workpath",
  path.join(pyinstallerRoot, "work"),
  "--specpath",
  path.join(pyinstallerRoot, "spec"),
  "--paths",
  path.join(backendRoot, "src")
];
for (const packageName of collectDataPackages) {
  pyinstallerArguments.push("--collect-data", packageName);
}
for (const packageName of collectBinaryPackages) {
  pyinstallerArguments.push("--collect-binaries", packageName);
}
for (const packageName of hiddenImports) {
  pyinstallerArguments.push("--hidden-import", packageName);
}
for (const packageName of metadataPackages) {
  pyinstallerArguments.push("--copy-metadata", packageName);
}
pyinstallerArguments.push(path.join(backendRoot, "packaging", "sidecar_entry.py"));
runPython(python, pyinstallerArguments);

if (!existsSync(executablePath)) fail("PyInstaller did not produce the expected sidecar executable.");
const probe = run(executablePath, ["--setup-probe"], { capture: true, timeout: 60_000 });
const sentinelIndex = probe.stdout.lastIndexOf(sentinel);
if (sentinelIndex < 0) fail("The bundled sidecar did not return its setup probe.");
const payload = JSON.parse(
  probe.stdout.slice(sentinelIndex + sentinel.length).split(/\r?\n/, 1)[0]
);
if (Object.values(payload.components ?? {}).some((state) => state !== "ready")) {
  fail("The bundled sidecar is missing a required runtime component.");
}

const shutdown = run(executablePath, [], {
  capture: true,
  input: `${JSON.stringify({ type: "shutdown" })}\n`,
  timeout: 60_000
});
if (!shutdown.stdout.split(/\r?\n/).some((line) => {
  try {
    const event = JSON.parse(line);
    return event.type === "engine_status" && event.status === "shutdown";
  } catch {
    return false;
  }
})) {
  fail("The bundled sidecar did not complete its JSONL shutdown smoke test.");
}

const tocPaths = ["Analysis-00.toc", "PYZ-00.toc", "COLLECT-00.toc"].map((name) => (
  path.join(pyinstallerRoot, "work", "meeting-transcriber-sidecar", name)
));
for (const tocPath of tocPaths) {
  if (!existsSync(tocPath)) fail(`PyInstaller did not produce ${path.basename(tocPath)}.`);
}
const inspection = runPython(python, [
  path.join(scriptDirectory, "inspect-python-runtime.py"),
  ...tocPaths.flatMap((tocPath) => ["--toc", tocPath]),
  "--project-distribution",
  "meeting-transcriber-sidecar"
], {
  capture: true
});
const inspectedPackages = JSON.parse(inspection.stdout);
const embeddedPythonEvidence = findEmbeddedPythonRuntime(
  path.dirname(executablePath),
  version.version
);
const runtimeInventory = {
  schemaVersion: 1,
  inventoryKind: "observed-packaged-runtime",
  target: {
    platform: process.platform,
    arch: process.arch
  },
  packagedRuntime: {
    cpython: {
      name: "CPython",
      version: version.version,
      evidencePath: embeddedPythonEvidence
    },
    pythonPackages: inspectedPackages.runtimePackages
  },
  buildEnvironment: {
    tools: inspectedPackages.buildEnvironmentTools,
    installedButNotObserved: inspectedPackages.installedButNotObserved
  },
  evidence: {
    pyinstallerRecords: tocPaths.map((tocPath) => (
      path.relative(repositoryRoot, tocPath).replaceAll("\\", "/")
    )),
    componentProbe: "passed",
    jsonlShutdownSmoke: "passed"
  },
  limitations: [
    "Runtime packages are those observed in this platform's PyInstaller analysis records.",
    "Transitive dependency versions are platform-resolved build inputs, not an immutable repository lock.",
    "Build tools are recorded separately and are not application runtime dependencies."
  ]
};
writeFileSync(
  inventoryPath,
  `${JSON.stringify(runtimeInventory, null, 2)}\n`,
  "utf8"
);
process.stdout.write(
  `${JSON.stringify({
    status: "ready",
    platform: process.platform,
    arch: process.arch,
    python: version.version,
    executable: path.relative(repositoryRoot, executablePath).replaceAll("\\", "/")
  })}\n`
);

function resolvePython() {
  const candidates = [];
  const override = process.env.MEETING_TRANSCRIBER_BUILD_PYTHON?.trim();
  if (override) candidates.push({ command: override, prefixArgs: [] });
  if (process.platform === "win32") {
    candidates.push(
      {
        command: path.join(backendRoot, ".venv", "Scripts", "python.exe"),
        prefixArgs: []
      },
      { command: "py", prefixArgs: ["-3.12"] },
      { command: "python", prefixArgs: [] }
    );
  } else {
    candidates.push(
      { command: path.join(backendRoot, ".venv", "bin", "python"), prefixArgs: [] },
      { command: "python3.12", prefixArgs: [] },
      { command: "python3", prefixArgs: [] }
    );
  }
  for (const candidate of candidates) {
    if (candidate.command.includes(path.sep) && !existsSync(candidate.command)) continue;
    const check = spawnSync(
      candidate.command,
      [...candidate.prefixArgs, "-I", "-c", "import sys; print(sys.implementation.name); print('.'.join(map(str, sys.version_info[:3])))"],
      { cwd: repositoryRoot, encoding: "utf8", windowsHide: true, shell: false }
    );
    const [implementation, candidateVersion] = check.stdout?.trim().split(/\r?\n/) ?? [];
    if (check.status === 0 && implementation === "cpython" && candidateVersion?.startsWith("3.12.")) {
      return candidate;
    }
  }
  fail("A CPython 3.12 build environment is required. Run the source bootstrap first.");
}

function readPythonVersion(python) {
  const completed = runPython(
    python,
    ["-I", "-c", "import json,platform; print(json.dumps({'implementation': platform.python_implementation(), 'version': platform.python_version()}))"],
    { capture: true }
  );
  const value = JSON.parse(completed.stdout);
  if (value.implementation !== "CPython" || !value.version.startsWith("3.12.")) {
    fail("The sidecar must be built with CPython 3.12.x.");
  }
  return value;
}

function findEmbeddedPythonRuntime(root, pythonVersion) {
  const [major, minor] = pythonVersion.split(".");
  const compactVersion = `${major}${minor}`;
  const expectedNames = process.platform === "win32"
    ? new Set([`python${compactVersion}.dll`])
    : new Set([`libpython${major}.${minor}.dylib`, `libpython${major}.${minor}.so`]);
  const candidates = findFiles(root).filter((candidate) => (
    expectedNames.has(path.basename(candidate).toLowerCase())
    || path.basename(candidate).toLowerCase().startsWith(`libpython${major}.${minor}.so.`)
    || (
      process.platform === "darwin"
      && path.basename(candidate) === "Python"
      && candidate.replaceAll("\\", "/").includes(`/Python.framework/Versions/${major}.${minor}/`)
    )
  ));
  if (candidates.length !== 1) {
    fail(`Expected one embedded CPython ${major}.${minor} runtime library; found ${candidates.length}.`);
  }
  return path.relative(root, candidates[0]).replaceAll("\\", "/");
}

function findFiles(root) {
  const matches = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      matches.push(...findFiles(candidate));
    } else if (entry.isFile() && statSync(candidate).size > 0) {
      matches.push(candidate);
    }
  }
  return matches;
}

function runPython(python, args, options = {}) {
  return run(python.command, [...python.prefixArgs, ...args], options);
}

function run(command, args, { capture = false, input, timeout = 20 * 60_000 } = {}) {
  const completed = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: sanitizedBuildEnvironment(),
    input,
    timeout,
    windowsHide: true,
    shell: false,
    stdio: capture ? ["pipe", "pipe", "pipe"] : "inherit"
  });
  if (completed.error || completed.status !== 0) {
    if (capture && completed.stderr) process.stderr.write(completed.stderr);
    fail(`Distribution command failed: ${path.basename(command)}.`);
  }
  return completed;
}

function sanitizedBuildEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (["PYTHONHOME", "PYTHONPATH", "VIRTUAL_ENV"].includes(normalized)) continue;
    environment[key] = value;
  }
  return {
    ...environment,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1"
  };
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
