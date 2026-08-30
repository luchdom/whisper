import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("main ingests Assist first, relays finalized data to the overlay, then finalizes before renderer relay", async () => {
  const main = await read("../main/index.js");
  const events = sliceBetween(main, 'backend.on("event"', "function createWindow");
  assert.equal(
    events.indexOf('if (event.type === "final_segment") assistController?.ingest(event)')
      < events.indexOf("overlayController?.ingestBackendEvent(event)"),
    true
  );
  assert.equal(
    events.indexOf("overlayController?.ingestBackendEvent(event)")
      < events.indexOf('if (event.type === "session_stopped") endAssistSession'),
    true
  );
  assert.equal(
    events.indexOf('if (event.type === "session_stopped") endAssistSession')
      < events.indexOf('webContents.send("meeting:backend-event"'),
    true
  );
});

test("overlay is revealed only by renderer-confirmed transcribing state, never by backend start", async () => {
  const main = await read("../main/index.js");
  const start = sliceBetween(main, 'ipcMain.handle("meeting:start"', 'ipcMain.handle("meeting:audio"');
  assert.match(start, /overlayController\?\.setMeetingState\("preparing"\)/);
  assert.match(start, /overlayController\?\.beginSession\(engine\.session_id\)/);
  assert.doesNotMatch(start, /overlayController\?\.(?:show|toggleVisibility)/);

  const tray = sliceBetween(
    main,
    'ipcMain.on("meeting:tray-state"',
    "function getRendererSettings"
  );
  assert.match(tray, /runtimeLifecycle\.isInterruptionLatched\(\)/);
  assert.match(tray, /reveal: state === "transcribing"/);
});

test("shortcut registry replaces the direct one-off global shortcut and remains independently recoverable", async () => {
  const main = await read("../main/index.js");
  assert.match(main, /createShortcutRegistry\(\{/);
  for (const action of [
    "showHide", "focusAssist", "cancelAssist", "opacityUp", "opacityDown", "toggleClickThrough"
  ]) assert.match(main, new RegExp(`${action}:`));
  assert.match(main, /shortcutRegistry\.retryUnavailable\(\)/);
  assert.match(main, /shortcutRegistry\.reset\(\)/);
  assert.match(main, /shortcutRegistry\?\.destroy\(\)/);
  assert.doesNotMatch(main, /globalShortcut\.register\("CommandOrControl\+Shift\+A"/);
  assert.doesNotMatch(main, /globalShortcut\.unregister\("CommandOrControl\+Shift\+A"/);
});

test("workspace and overlay preloads expose narrow companion actions without capture or provider-send APIs", async () => {
  const [workspacePreload, overlayPreload] = await Promise.all([
    read("../preload/index.cjs"),
    read("../preload/overlay.cjs")
  ]);
  for (const method of [
    "getOverlayStatus",
    "showOverlay",
    "hideOverlay",
    "updateOverlaySettings",
    "acknowledgeOverlayPrivateMode",
    "resetOverlay",
    "retryOverlayShortcuts",
    "resetOverlayShortcuts",
    "toggleOverlayClickThrough",
    "onOverlayStatus",
    "onAssistPrefill"
  ]) assert.match(workspacePreload, new RegExp(`\\b${method}:`));

  for (const channel of [
    "overlay:status",
    "overlay:show-workspace",
    "overlay:focus-assist",
    "overlay:hide"
  ]) assert.match(overlayPreload, new RegExp(escapeRegex(channel)));
  assert.doesNotMatch(overlayPreload, /meeting:start|meeting:audio|assist-request|provider|credential|context-pack/);
});

test("overlay renderer stays overt and offers only workspace, Copilot focus, and hide controls", async () => {
  const [html, renderer, styles] = await Promise.all([
    read("../renderer/overlay.html"),
    read("../renderer/overlay.js"),
    read("../renderer/overlay.css")
  ]);
  assert.match(html, /Ready — not recording/);
  assert.match(html, /Never starts recording/);
  assert.match(html, /Finalized only/);
  assert.match(html, /class="capture-strip" aria-labelledby="meeting-state-label">/);
  assert.match(html, /class="capture-copy" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /id="elapsed"[^>]*aria-live="off"/);
  assert.match(html, /id="meeting-issue" hidden/);
  assert.match(renderer, /bridge\.showWorkspace\(\)/);
  assert.match(renderer, /bridge\.focusCopilot\(\)/);
  assert.match(renderer, /bridge\.hide\(\)/);
  assert.doesNotMatch(renderer, /getUserMedia|getDisplayMedia|sendAudio|start\(/);
  assert.match(renderer, /privacy aid, not invisibility/);
  assert.match(renderer, /const INITIAL_STATUS_RETRY_DELAYS_MS = Object\.freeze\(\[0, 200, 600\]\);/);
  assert.match(renderer, /void loadInitialStatus\(\)\.catch\(\(\) => false\);/);
  assert.match(renderer, /renderMeetingIssue\(status\.meeting\.issue\)/);
  assert.match(renderer, /Previous suggestion — the transcript changed after it was generated\./);
  assert.match(renderer, /for \(const delayMs of INITIAL_STATUS_RETRY_DELAYS_MS\)/);
  assert.match(renderer, /try \{[^]*?await bridge\.getStatus\(\)[^]*?\} catch \{/s);
  assert.match(renderer, /if \(signature === renderedSegmentsSignature\) return;/);
  assert.match(renderer, /if \(signature === renderedSuggestionSignature\) return;/);
  assert.match(renderer, /function setTextIfChanged\(element, value\)/);
  assert.match(styles, /-webkit-app-region: drag/);
  assert.match(html, /class="brand-mark" src="\.\.\/build\/icon\.png"/);
  assert.doesNotMatch(styles, /\.provider-disclosure\s*\{[^}]*display:\s*none/s);
  assert.match(styles, /\.privacy-footer,\s*\.provider-disclosure\s*\{[^}]*font-size:\s*12px/s);
  assert.match(styles, /\.eyebrow,\s*\.provider-state\s*\{[^}]*font-size:\s*12px/s);
  assert.match(styles, /\.primary-button\s*\{[^}]*min-height:\s*36px[^}]*font-size:\s*12px/s);
  assert.match(styles, /@media \(max-width: 470px\)[^]*?grid-template-columns: minmax\(0, 1\.25fr\) minmax\(160px, 0\.9fr\)/s);
});

test("overlay startup retry is bounded and timer-only ticks do not rebuild live regions", async () => {
  const renderer = await read("../renderer/overlay.js");
  const successful = executeOverlayRenderer(renderer, { failuresBeforeSuccess: 2 });
  await settleRendererStartup();

  assert.equal(successful.getStatusAttempts(), 3);
  assert.equal(successful.elements.get("#segments").replaceCount, 1);
  assert.equal(successful.elements.get("#suggestion").replaceCount, 1);

  successful.publish({
    ...successful.status,
    meeting: { ...successful.status.meeting, elapsedMs: 1_000 }
  });
  assert.equal(successful.elements.get("#segments").replaceCount, 1);
  assert.equal(successful.elements.get("#suggestion").replaceCount, 1);

  successful.publish({
    ...successful.status,
    meeting: {
      ...successful.status.meeting,
      elapsedMs: 2_000,
      segments: [{ ...successful.status.meeting.segments[0], text: "A changed finalized segment." }]
    }
  });
  assert.equal(successful.elements.get("#segments").replaceCount, 2);
  assert.equal(successful.elements.get("#suggestion").replaceCount, 1);

  const unavailable = executeOverlayRenderer(renderer, { failuresBeforeSuccess: Infinity });
  await settleRendererStartup();
  assert.equal(unavailable.getStatusAttempts(), 3);
});

async function read(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

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

function executeOverlayRenderer(source, { failuresBeforeSuccess }) {
  const elements = new Map();
  const createElement = (tagName = "div") => ({
    tagName: tagName.toUpperCase(),
    className: "",
    dataset: {},
    dateTime: "",
    textContent: "",
    children: [],
    replaceCount: 0,
    addEventListener() {},
    append(...children) {
      this.children.push(...children);
    },
    replaceChildren(...children) {
      this.children = children;
      this.replaceCount += 1;
    }
  });
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, createElement());
      return elements.get(selector);
    },
    createElement
  };
  const status = {
    meeting: {
      recording: true,
      label: "Transcribing",
      sourceSummary: "Meeting audio",
      elapsedMs: 0,
      segments: [{
        id: "segment-1",
        speaker: "Speaker 1",
        source: "System audio",
        text: "A finalized segment.",
        translation: null
      }]
    },
    assist: { state: "idle", suggestion: null },
    provider: {
      label: "Local transcript only",
      disclosure: "Nothing is sent without explicit approval."
    },
    overlay: { mode: "accessible", opacity: 1 }
  };
  let getStatusAttempts = 0;
  let statusListener = null;
  const bridge = {
    showWorkspace: async () => ({ ok: true }),
    focusCopilot: async () => ({ ok: true }),
    hide: async () => ({ ok: true }),
    onStatus(listener) {
      statusListener = listener;
    },
    async getStatus() {
      getStatusAttempts += 1;
      if (getStatusAttempts <= failuresBeforeSuccess) throw new Error("IPC is not ready yet.");
      return { ok: true, status };
    }
  };

  runInNewContext(source, {
    window: { overlay: bridge },
    document,
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    }
  });

  return {
    elements,
    status,
    getStatusAttempts: () => getStatusAttempts,
    publish(value) {
      statusListener(value);
    }
  };
}

async function settleRendererStartup() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
