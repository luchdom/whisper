import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DebriefContextBuffer } from "../main/debrief-context.js";

test("main starts fresh debrief context only after the backend owns a session", async () => {
  const main = await readMain();
  const start = sliceBetween(
    main,
    'ipcMain.handle("meeting:start"',
    'ipcMain.handle("meeting:audio"'
  );
  const backendStart = start.indexOf("await backend.startSession");
  const debriefStart = start.indexOf("startLocalDebriefSession(engine.session_id)");

  assert.equal(backendStart >= 0, true);
  assert.equal(debriefStart > backendStart, true);
  assert.doesNotMatch(
    start.slice(0, backendStart),
    /debriefContext\.(?:startSession|clear)|startLocalDebriefSession/
  );
  assert.match(
    main,
    /function startLocalDebriefSession\(sessionId\)[^]*?debriefContext\.startSession\(sessionId\)[^]*?catch \{[^]*?debriefContext\.clear\(\)/
  );
});

test("accepted finals and revisions enter debrief context before any overlay or renderer relay", async () => {
  const main = await readMain();
  const events = sliceBetween(main, 'backend.on("event"', "function createWindow");
  const ingest = events.indexOf("ingestLocalDebriefEvent(event)");

  assert.equal(ingest >= 0, true);
  assert.equal(ingest < events.indexOf("assistController?.ingest(event)"), true);
  assert.equal(ingest < events.indexOf("overlayController?.ingestBackendEvent(event)"), true);
  assert.equal(ingest < events.indexOf('webContents.send("meeting:backend-event"'), true);
  assert.match(
    main,
    /function ingestLocalDebriefEvent\(event\)[^]*?debriefContext\.ingest\(event\)/
  );

  const buffer = new DebriefContextBuffer();
  buffer.startSession("session-revision");
  assert.notEqual(buffer.ingest(finalEvent("session-revision", 1, "first text")), false);
  assert.notEqual(buffer.ingest(finalEvent("session-revision", 2, "corrected text")), false);
  const snapshot = buffer.snapshot();
  assert.equal(snapshot.revision, 2);
  assert.equal(snapshot.segments.length, 1);
  assert.equal(snapshot.segments[0].text, "corrected text");
});

test("main finalizes complete and incomplete meetings idempotently without clearing retained context", async () => {
  const main = await readMain();
  const events = sliceBetween(main, 'backend.on("event"', "function createWindow");
  const stop = sliceBetween(
    main,
    'ipcMain.handle("meeting:stop"',
    'ipcMain.handle("meeting:debrief-generate"'
  );

  assert.match(
    events,
    /finalizeLocalDebriefSession\(event\.session_id, event\.reason \?\? "unknown"\)/
  );
  assert.equal(
    events.indexOf("finalizeLocalDebriefSession")
      < events.indexOf("overlayController?.ingestBackendEvent(event)"),
    true
  );
  assert.match(stop, /lastSessionStopReason \?\? "stop_failed"/);
  assert.doesNotMatch(stop, /debriefContext\.clear\(/);
  assert.match(
    main,
    /complete: resolvedReason === "stopped"/
  );

  const complete = new DebriefContextBuffer();
  complete.startSession("complete");
  complete.ingest(finalEvent("complete", 1, "We decided to ship."));
  const completedSnapshot = complete.finalizeSession("complete", {
    complete: true,
    reason: "stopped"
  });
  assert.equal(complete.finalizeSession("complete", { complete: false, reason: "fatal" }), false);
  assert.deepEqual(complete.snapshot(), completedSnapshot);

  const incomplete = new DebriefContextBuffer();
  incomplete.startSession("incomplete");
  incomplete.ingest(finalEvent("incomplete", 1, "A completed segment remains."));
  incomplete.finalizeSession("incomplete", { complete: false, reason: "stop_failed" });
  assert.equal(incomplete.snapshot().state, "incomplete");
  assert.equal(incomplete.snapshot().segments.length, 1);
});

test("local debrief IPC accepts no renderer context and has no provider or network route", async () => {
  const [main, preload] = await Promise.all([
    readMain(),
    readFile(new URL("../preload/index.cjs", import.meta.url), "utf8")
  ]);
  const generate = sliceBetween(
    main,
    'ipcMain.handle("meeting:debrief-generate"',
    'ipcMain.handle("meeting:debrief-copy"'
  );

  assert.match(generate, /\(event, \.\.\.args\)/);
  assert.match(generate, /if \(args\.length !== 0\) return invalidDebriefRequestResult\(\)/);
  assert.match(generate, /const snapshot = debriefContext\.snapshot\(\)/);
  assert.match(generate, /if \(snapshot\.state === "active"\)/);
  assert.match(generate, /extractLocalDebrief\(snapshot, \{ includeCoaching: true \}\)/);
  assert.match(generate, /return \{ ok: true, debrief: sanitizeRendererDebrief\(debrief\) \}/);
  assert.doesNotMatch(
    generate,
    /ProviderController|providerController|fetch|https?|credential|consent|model|profile|contextPack|assistController/
  );
  assert.doesNotMatch(generate, /args\[|renderer.*(?:context|transcript)|snapshot\s*:/i);

  assert.match(
    preload,
    /generateLocalDebrief: \(\) => ipcRenderer\.invoke\("meeting:debrief-generate"\)/
  );
  assert.match(
    preload,
    /copyDebrief: \(markdown\) => ipcRenderer\.invoke\("meeting:debrief-copy", markdown\)/
  );
  assert.match(
    preload,
    /saveDebrief: \(markdown\) => ipcRenderer\.invoke\("meeting:debrief-save", markdown\)/
  );
  assert.match(
    preload,
    /clearLocalDebrief: \(\) => ipcRenderer\.invoke\("meeting:debrief-clear"\)/
  );
  assert.doesNotMatch(
    preload,
    /generateLocalDebrief:\s*\([^)]*(?:context|transcript|provider|model)/i
  );
});

test("debrief copy, save, and clear remain bounded, manual, and independent", async () => {
  const main = await readMain();
  const copy = sliceBetween(
    main,
    'ipcMain.handle("meeting:debrief-copy"',
    'ipcMain.handle("meeting:debrief-save"'
  );
  const save = sliceBetween(
    main,
    'ipcMain.handle("meeting:debrief-save"',
    'ipcMain.handle("meeting:debrief-clear"'
  );
  const clear = sliceBetween(
    main,
    'ipcMain.handle("meeting:debrief-clear"',
    'ipcMain.handle("meeting:copy"'
  );

  assert.match(copy, /clipboard\.writeText\(validateDebriefMarkdown\(markdown\)\)/);
  assert.match(save, /const validatedMarkdown = validateDebriefMarkdown\(markdown\)/);
  assert.match(save, /title: "Save Meeting debrief"/);
  assert.match(save, /const suggestedName = buildDebriefFileName\(\)/);
  assert.match(main, /return `Meeting debrief-\$\{timestamp\}\.md`/);
  assert.match(main, /validateFinalMarkdown\(markdown, MAX_DEBRIEF_MARKDOWN_BYTES\)/);
  assert.doesNotMatch(save, /autoSave|email|post|task|shell\.openExternal|fetch/);
  assert.match(clear, /debriefContext\.clear\(\)/);
  assert.match(clear, /debriefContext\.snapshot\(\)\?\.state === "active"/);
  assert.doesNotMatch(clear, /transcriptFiles|assistController|providerController|backend|settings/);
  assert.match(clear, /return \{ ok: true \}/);
});

function finalEvent(sessionId, revision, text) {
  return {
    type: "final_segment",
    session_id: sessionId,
    segment: {
      id: "segment-1",
      revision,
      start_ms: 1_000,
      end_ms: 3_000,
      track: "system",
      text,
      partial: false,
      final: true,
      language: "en",
      speaker_id: "speaker-1",
      translated_text: null,
      translated_language: null
    }
  };
}

function readMain() {
  return readFile(new URL("../main/index.js", import.meta.url), "utf8");
}

function sliceBetween(value, start, end) {
  const startIndex = value.indexOf(start);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return value.slice(startIndex, endIndex);
}
