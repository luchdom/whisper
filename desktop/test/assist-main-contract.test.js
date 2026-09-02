import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("main ingests accepted finals before renderer relay and binds Assist to backend session lifecycle", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  const backendEvents = sliceBetween(main, 'backend.on("event"', "function createWindow");
  assert.equal(
    backendEvents.indexOf('event.type === "final_segment"')
      < backendEvents.indexOf('webContents.send("meeting:backend-event"'),
    true
  );
  assert.equal(
    backendEvents.indexOf('event.type === "session_stopped"')
      < backendEvents.indexOf('webContents.send("meeting:backend-event"'),
    true
  );

  const start = sliceBetween(
    main,
    'ipcMain.handle("meeting:start"',
    'ipcMain.handle("meeting:audio"'
  );
  assert.match(start, /const engine = await backend\.startSession/);
  assert.match(start, /const sessionContext = await resolveAssistSelection\(assistSelection\)/);
  assert.match(start, /startAssistSession\(engine\.session_id, sessionContext\)/);
  assert.equal(start.indexOf("resolveAssistSelection") < start.indexOf("await backend.startSession"), true);
  assert.equal(start.indexOf("await backend.startSession") < start.indexOf("startAssistSession"), true);
  assert.equal(start.indexOf("startAssistSession") < start.indexOf("return { ok: true, engine }"), true);
  assert.match(main, /function endAssistSession\(sessionId\)[^]*?assistController\?\.endSession\(sessionId\)[^]*?providerController\?\.stopSession\(sessionId\)/);
});

test("a rejected stale start cannot overwrite an active capture's tray or overlay state", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  const start = sliceBetween(
    main,
    'ipcMain.handle("meeting:start"',
    'ipcMain.handle("meeting:audio"'
  );

  assert.match(start, /let startTransitionBegan = false;/);
  assert.equal(
    start.indexOf("if (meetingInProgress)") < start.indexOf("startTransitionBegan = true"),
    true
  );
  assert.equal(
    start.indexOf("if (settingsAreLocked())") < start.indexOf("startTransitionBegan = true"),
    true
  );
  assert.equal(
    start.indexOf("await resolveAssistSelection") < start.indexOf("startTransitionBegan = true"),
    true
  );
  assert.match(
    start,
    /catch \(error\) \{\s*runtimeLifecycle\.failCaptureAttempt\(captureAttempt\);\s*if \(startTransitionBegan\) \{\s*trayController\?\.setState\("error"\);\s*overlayController\?\.setMeetingState\("error"\);\s*\}/s
  );
});

test("Assist IPC and preload are narrow, question-only, and main-owned", async () => {
  const [main, preload, protocol] = await Promise.all([
    readFile(new URL("../main/index.js", import.meta.url), "utf8"),
    readFile(new URL("../preload/index.cjs", import.meta.url), "utf8"),
    readFile(new URL("../main/assist-protocol.js", import.meta.url), "utf8")
  ]);

  for (const channel of [
    "meeting:assist-status",
    "meeting:assist-context",
    "meeting:assist-consent",
    "meeting:assist-request",
    "meeting:assist-cancel"
  ]) assert.match(main, new RegExp(escapeRegex(channel)));
  assert.match(main, /normalizeRendererAssistRequest\(value\)/);
  assert.match(main, /typeof enabled !== "boolean"/);
  assert.match(main, /providerController\.grantConsent\(\{\s*sessionId: snapshot\.sessionId,\s*disclosureVersion: PROVIDER_DISCLOSURE_VERSION/s);
  assert.match(main, /if \(!enabled\) \{\s*fakeAssistConsent = null;\s*providerController\?\.revokeConsent\(\)/s);
  assert.match(main, /assistController\.request\(request\)/);
  assert.match(main, /meeting:assist-context[^]*?assistController\?\.freezeContextForRequest\(\)/);
  assert.match(main, /if \(!snapshot \|\| snapshot\.segments\.length === 0\) return null;/);
  assert.doesNotMatch(
    sliceBetween(main, 'ipcMain.handle("meeting:assist-request"', 'ipcMain.handle("meeting:assist-cancel"'),
    /sessionId\s*:\s*value|contextRevision\s*:\s*value|endpoint|model|credential/
  );

  for (const method of [
    "getAssistStatus",
    "getAssistContext",
    "setAssistConsent",
    "requestAssist",
    "cancelAssist",
    "onAssistEvent",
    "onAssistShortcut"
  ]) assert.match(preload, new RegExp(`\\b${method}:`));
  assert.match(preload, /requestAssist: \(\{ question \}\) => ipcRenderer\.invoke\("meeting:assist-request", \{ question \}\)/);
  assert.doesNotMatch(preload, /requestAssist:[^\n]*(?:sessionId|contextRevision|objective|ephemeralContext|model|endpoint)/);
  assert.match(protocol, /value,[\s\n]*\["question"\],[\s\n]*"assistance request"/);
});

test("global Assist shortcut only reveals the UI and fake assistance is development-only", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  const registry = await readFile(new URL("../main/shortcut-registry.js", import.meta.url), "utf8");
  const shortcut = sliceBetween(
    main,
    "function createShortcutBoundary()",
    "function updateShortcutStatus"
  );
  assert.match(shortcut, /focusAssist: \(\) => showMainWindow\(\{ focusAssist: true \}\)/);
  assert.doesNotMatch(shortcut, /backend|startSession|sendAudio|grantConsent|request\(/);
  assert.match(registry, /action: "focusAssist"[\s\S]*accelerator: "CommandOrControl\+Shift\+A"/);
  assert.match(main, /shortcutRegistry\?\.destroy\(\)/);
  assert.doesNotMatch(main, /globalShortcut\.register\("CommandOrControl\+Shift\+A"/);
  assert.match(
    main,
    /return !app\.isPackaged && process\.env\.MEETING_TRANSCRIBER_FAKE_ASSIST === "1";/
  );
  assert.match(main, /if \(focusAssist\) mainWindow\.webContents\.send\("meeting:assist-shortcut"\)/);
});

test("release check gate includes every meeting-context, assistance, lifecycle, overlay, and debrief boundary module", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.version, "0.10.0");
  for (const path of [
    "desktop/main/assist-context.js",
    "desktop/main/assist-protocol.js",
    "desktop/main/assist-provider-adapter.js",
    "desktop/main/fake-assist-provider.js",
    "desktop/main/assist-controller.js",
    "desktop/main/meeting-profiles.js",
    "desktop/main/context-pack-store.js",
    "desktop/main/debrief-context.js",
    "desktop/main/debrief-extractor.js",
    "desktop/main/runtime-lifecycle.js",
    "desktop/main/overlay-controller.js",
    "desktop/main/overlay-policy.js",
    "desktop/main/overlay-settings-store.js",
    "desktop/main/shortcut-registry.js",
    "desktop/renderer/lib/assist-request-gate.js",
    "desktop/renderer/lib/debrief-store.js",
    "desktop/renderer/overlay.js",
    "desktop/preload/overlay.cjs"
  ]) assert.match(packageJson.scripts.check, new RegExp(escapeRegex(path)));
});

function sliceBetween(value, start, end) {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return value.slice(startIndex, endIndex);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
