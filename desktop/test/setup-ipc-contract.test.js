import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("setup IPC is argument-free and exposes no command, URL, package, or path input", async () => {
  const preload = await readFile(new URL("../preload/index.cjs", import.meta.url), "utf8");

  assert.match(preload, /getEnginePrerequisites:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("meeting:engine-prerequisites"\)/);
  assert.match(preload, /openPythonDownloadPage:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("meeting:open-python-download"\)/);
  assert.match(preload, /copyBootstrapCommand:\s*\(\)\s*=>\s*ipcRenderer\.invoke\("meeting:copy-bootstrap-command"\)/);
  assert.doesNotMatch(preload, /openPythonDownloadPage:\s*\([^)]/);
  assert.doesNotMatch(preload, /copyBootstrapCommand:\s*\([^)]/);
});

test("main owns the official Python URL and the fixed source bootstrap command", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  const pythonHandler = main.slice(
    main.indexOf('ipcMain.handle("meeting:open-python-download"'),
    main.indexOf('ipcMain.handle("meeting:copy-bootstrap-command"')
  );
  const bootstrapHandler = main.slice(
    main.indexOf('ipcMain.handle("meeting:copy-bootstrap-command"'),
    main.indexOf('ipcMain.on("meeting:close-ready"')
  );

  assert.match(main, /https:\/\/www\.python\.org\/downloads\/release\/python-31210\//);
  assert.match(pythonHandler, /shell\.openExternal\(PYTHON_DOWNLOAD_URL\)/);
  assert.doesNotMatch(pythonHandler, /openExternal\([^P]/);
  assert.match(main, /const BOOTSTRAP_COMMAND = process\.platform/);
  assert.match(bootstrapHandler, /if \(app\.isPackaged\)/);
  assert.match(bootstrapHandler, /clipboard\.writeText\(BOOTSTRAP_COMMAND\)/);
});

test("meeting start fails closed until the local engine doctor has verified a launch", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  const startHandler = main.slice(
    main.indexOf('ipcMain.handle("meeting:start"'),
    main.indexOf('ipcMain.handle("meeting:audio"')
  );

  const check = startHandler.indexOf("await backendSetup.check()");
  const readyGate = startHandler.indexOf('setup.state !== "ready"');
  const start = startHandler.indexOf("await backend.startSession");
  assert.equal(check >= 0, true);
  assert.equal(check < readyGate, true);
  assert.equal(readyGate < start, true);
  assert.match(main, /getVerifiedLaunch:\s*\(\)\s*=>\s*backendSetup\.getVerifiedLaunch\(\)/);
});

test("the public doctor result contains only normalized setup fields", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  const handler = main.slice(
    main.indexOf('ipcMain.handle("meeting:engine-prerequisites"'),
    main.indexOf('ipcMain.handle("meeting:open-python-download"')
  );

  for (const field of ["state", "python", "components", "sourceSetupAvailable", "platform"]) {
    assert.match(handler, new RegExp(`\\b${field}\\b`));
  }
  assert.doesNotMatch(handler, /command|prefixArgs|stderr|executable|backendRoot|filePath/);
});

test("IPC handler errors expose only explicitly allowlisted product messages", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  const allowlistDeclaration = main.match(
    /const PUBLIC_ERROR_MESSAGES = new Set\(\[[\s\S]*?\n\]\);/
  )?.[0];
  const functionDeclaration = main.match(
    /function publicError\(error, fallback\) \{[\s\S]*?\n\}/
  )?.[0];

  assert.ok(allowlistDeclaration, "public error allowlist declaration");
  assert.ok(functionDeclaration, "publicError declaration");
  const publicError = Function(
    `"use strict";\n${allowlistDeclaration}\n${functionDeclaration}\nreturn publicError;`
  )();
  const fallback = "The operation could not be completed.";
  const sentinel = "C:\\Users\\private\\meeting.md api_key=super-secret";

  assert.equal(publicError(new Error(sentinel), fallback), fallback);
  assert.equal(publicError({ message: sentinel }, fallback), fallback);
  assert.equal(publicError(new Error("The selected model is not supported."), fallback),
    "The selected model is not supported.");
});
