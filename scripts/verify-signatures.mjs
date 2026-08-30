import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const WINDOWS_SIGNING_EXTENSIONS = new Set([".exe", ".dll", ".pyd"]);

function isPresent(environment, name) {
  return typeof environment[name] === "string" && environment[name].trim().length > 0;
}

function requireCredentialPair(environment, linkName, passwordName, label) {
  const hasLink = isPresent(environment, linkName);
  const hasPassword = isPresent(environment, passwordName);

  if (hasLink && hasPassword) {
    return;
  }

  if (hasLink || hasPassword) {
    throw new Error(`${label} credentials are incomplete; set both ${linkName} and ${passwordName}.`);
  }

  throw new Error(`${label} credentials are missing; set ${linkName} and ${passwordName}.`);
}

function configuredCredentialSets(environment, definitions) {
  return definitions.map((definition) => ({
    ...definition,
    complete: definition.names.every((name) => isPresent(environment, name)),
    mentioned: definition.names.some((name) => isPresent(environment, name))
  }));
}

export function assertSigningCredentials({ platform = process.platform, environment = process.env } = {}) {
  if (platform === "win32") {
    if (isPresent(environment, "WIN_CSC_LINK") || isPresent(environment, "WIN_CSC_KEY_PASSWORD")) {
      requireCredentialPair(
        environment,
        "WIN_CSC_LINK",
        "WIN_CSC_KEY_PASSWORD",
        "Windows Authenticode"
      );
      return { platform, signingMethod: "WIN_CSC_LINK" };
    }

    requireCredentialPair(environment, "CSC_LINK", "CSC_KEY_PASSWORD", "Windows Authenticode");
    return { platform, signingMethod: "CSC_LINK" };
  }

  if (platform === "darwin") {
    requireCredentialPair(environment, "CSC_LINK", "CSC_KEY_PASSWORD", "macOS Developer ID");

    const notarizationSets = configuredCredentialSets(environment, [
      {
        method: "apple-id",
        names: ["APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]
      },
      {
        method: "app-store-connect-api-key",
        names: ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER"]
      },
      {
        method: "keychain-profile",
        names: ["APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE"]
      }
    ]);
    const completeSets = notarizationSets.filter(({ complete }) => complete);
    const incompleteSets = notarizationSets.filter(({ mentioned, complete }) => mentioned && !complete);

    if (incompleteSets.length > 0) {
      const details = incompleteSets
        .map(({ method, names }) => `${method} (${names.join(", ")})`)
        .join("; ");
      throw new Error(`macOS notarization credentials are incomplete: ${details}.`);
    }
    if (completeSets.length === 0) {
      throw new Error(
        "macOS notarization credentials are missing; configure Apple ID, App Store Connect API key, or keychain profile credentials."
      );
    }
    if (completeSets.length > 1) {
      throw new Error("Configure exactly one macOS notarization credential method.");
    }

    return {
      platform,
      signingMethod: "CSC_LINK",
      notarizationMethod: completeSets[0].method
    };
  }

  throw new Error(`Signed distributions are supported only on Windows and macOS, not ${platform}.`);
}

async function walkFiles(rootDirectory, currentDirectory = rootDirectory) {
  const entries = await readdir(currentDirectory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(currentDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(rootDirectory, entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

export async function collectSignatureTargets({ platform = process.platform, distDirectory = "dist" } = {}) {
  const absoluteDistDirectory = path.resolve(distDirectory);
  const files = await walkFiles(absoluteDistDirectory);

  if (platform === "win32") {
    return files
      .filter((filePath) => WINDOWS_SIGNING_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
      .sort();
  }

  if (platform === "darwin") {
    const apps = new Set();
    for (const filePath of files) {
      let candidate = path.dirname(filePath);
      let outermostApp = null;
      while (candidate.startsWith(absoluteDistDirectory)) {
        if (candidate.toLowerCase().endsWith(".app")) {
          outermostApp = candidate;
        }
        if (candidate === absoluteDistDirectory) {
          break;
        }
        candidate = path.dirname(candidate);
      }
      if (outermostApp) {
        apps.add(outermostApp);
      }
    }

    return [...apps].sort();
  }

  throw new Error(`Signature verification is supported only on Windows and macOS, not ${platform}.`);
}

function runChecked(command, argumentsList) {
  const result = spawnSync(command, argumentsList, {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (result.error) {
    throw new Error(`Could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr || result.stdout || "verification failed"}`.trim();
    throw new Error(`${command} rejected an artifact: ${detail}`);
  }
}

let powerShellExecutable = null;

function resolvePowerShellExecutable() {
  if (powerShellExecutable) {
    return powerShellExecutable;
  }

  const probe = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], {
    encoding: "utf8",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  powerShellExecutable = probe.error ? "powershell.exe" : "pwsh";
  return powerShellExecutable;
}

function verifyWindowsTarget(target) {
  const escapedTarget = target.replaceAll("'", "''");
  const command = [
    `$signature = Get-AuthenticodeSignature -LiteralPath '${escapedTarget}'`,
    "if ($signature.Status -ne 'Valid') {",
    "  throw ('Invalid Authenticode signature ({0}): {1}' -f $signature.Status, $signature.Path)",
    "}"
  ].join("; ");
  runChecked(resolvePowerShellExecutable(), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command
  ]);
}

function verifyMacTarget(target) {
  runChecked("codesign", ["--verify", "--deep", "--strict", "--verbose=2", target]);
  runChecked("xcrun", ["stapler", "validate", target]);
}

export async function verifyDistributionSignatures({
  platform = process.platform,
  distDirectory = "dist"
} = {}) {
  const targets = await collectSignatureTargets({ platform, distDirectory });
  if (targets.length === 0) {
    throw new Error(`No ${platform === "win32" ? "Authenticode" : "macOS"} verification targets found in ${path.resolve(distDirectory)}.`);
  }

  for (const target of targets) {
    if (platform === "win32") {
      verifyWindowsTarget(target);
    } else {
      verifyMacTarget(target);
    }
  }

  return { platform, targetCount: targets.length };
}

function parseArguments(argumentsList) {
  const mode = argumentsList[0];
  if (mode !== "--preflight" && mode !== "--verify") {
    throw new Error("Usage: node scripts/verify-signatures.mjs --preflight | --verify [--dist <directory>]");
  }

  let distDirectory = "dist";
  if (argumentsList.length > 1) {
    if (argumentsList[1] !== "--dist" || !argumentsList[2] || argumentsList.length !== 3) {
      throw new Error("Usage: node scripts/verify-signatures.mjs --preflight | --verify [--dist <directory>]");
    }
    distDirectory = argumentsList[2];
  }
  return { mode, distDirectory };
}

async function main() {
  const { mode, distDirectory } = parseArguments(process.argv.slice(2));
  if (mode === "--preflight") {
    const result = assertSigningCredentials();
    const notarization = result.notarizationMethod
      ? ` and ${result.notarizationMethod} notarization credentials`
      : "";
    process.stdout.write(`Signing credential preflight passed for ${result.platform}${notarization}.\n`);
    return;
  }

  const result = await verifyDistributionSignatures({ distDirectory });
  process.stdout.write(`Verified ${result.targetCount} signed artifact target(s) for ${result.platform}.\n`);
}

const invokedScriptUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invokedScriptUrl) {
  main().catch((error) => {
    process.stderr.write(`Signed distribution verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
