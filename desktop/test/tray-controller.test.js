import assert from "node:assert/strict";
import test from "node:test";
import {
  TRAY_STATES,
  buildMenuTemplate,
  createTrayController,
  createTrayIconDataUrl,
  validateTrayStateDto
} from "../main/tray-controller.js";

class FakeTray {
  constructor(image) {
    this.image = image;
    this.handlers = new Map();
    this.destroyed = false;
  }

  on(event, listener) {
    this.handlers.set(event, listener);
  }

  setImage(image) {
    this.image = image;
  }

  setToolTip(value) {
    this.toolTip = value;
  }

  setTitle(value) {
    this.title = value;
  }

  setContextMenu(value) {
    this.menu = value;
  }

  destroy() {
    this.destroyed = true;
  }
}

test("tray state DTOs are exact and contain no renderer-authored copy", () => {
  assert.deepEqual(validateTrayStateDto({ state: "transcribing" }), { state: "transcribing" });
  assert.equal(validateTrayStateDto({ state: "transcribing", transcript: "secret" }), null);
  assert.equal(validateTrayStateDto({ state: "other" }), null);
  assert.equal(validateTrayStateDto("transcribing"), null);
});

test("every tray state has a deterministic, non-identical symbolic image", () => {
  const images = TRAY_STATES.map(createTrayIconDataUrl);
  assert.equal(new Set(images).size, TRAY_STATES.length);
  for (const image of images) assert.match(image, /^data:image\/png;base64,/);
});

test("tray actions never start capture and recording keeps a timer and Stop action", () => {
  let clock = 10_000;
  let tick = null;
  let cleared = false;
  const shown = [];
  let stops = 0;
  let quits = 0;
  const nativeImage = {
    createFromDataURL: (url) => ({
      url,
      isEmpty: () => false,
      setTemplateImage(value) {
        this.template = value;
      }
    })
  };
  const Menu = { buildFromTemplate: (template) => template };
  let trayInstance = null;
  class TestTray extends FakeTray {
    constructor(image) {
      super(image);
      trayInstance = this;
    }
  }
  const controller = createTrayController({
    Tray: TestTray,
    Menu,
    nativeImage,
    platform: "darwin",
    showWindow: (options) => shown.push(options),
    requestStop: () => { stops += 1; },
    requestQuit: () => { quits += 1; },
    now: () => clock,
    setTimer: (listener) => {
      tick = listener;
      return 7;
    },
    clearTimer: (id) => {
      assert.equal(id, 7);
      cleared = true;
    }
  });
  // Start is presentation-only: the callback can show and focus the window,
  // but this controller has no capture-start callback.
  const idleMenu = buildMenuTemplate({
    state: "idle",
    statusLabel: "Ready to start",
    showWindow: (options) => shown.push(options),
    requestStop: () => { stops += 1; },
    requestQuit: () => { quits += 1; }
  });
  idleMenu.find(({ label }) => label === "Start transcription…").click();
  assert.deepEqual(shown, [{ focusStart: true }]);

  controller.setState("preparing");
  assert.ok(trayInstance.menu.find(({ label }) => label === "Cancel preparation"));
  controller.setState("transcribing");
  clock += 65_000;
  tick();
  assert.equal(controller.state, "transcribing");
  assert.equal(trayInstance.toolTip, "Meeting Transcriber — Recording 00:01:05");
  assert.equal(trayInstance.title, " REC 00:01:05");
  assert.ok(trayInstance.menu.find(({ label }) => label === "Stop transcription"));

  // Read through the FakeTray instance retained by the constructor wrapper.
  // Menu behavior is independently deterministic for native Electron.
  const activeMenu = buildMenuTemplate({
    state: "transcribing",
    statusLabel: "Recording 00:01:05",
    showWindow: () => {},
    requestStop: () => { stops += 1; },
    requestQuit: () => { quits += 1; }
  });
  activeMenu.find(({ label }) => label === "Stop transcription").click();
  assert.equal(stops, 1);

  controller.setState("stopped");
  assert.equal(cleared, true);
  controller.destroy();
  assert.equal(trayInstance.destroyed, true);
  assert.throws(() => controller.setState("unknown"), /Unsupported tray state/);
});

test("tray menus always expose Show and explicit Quit", () => {
  for (const state of TRAY_STATES) {
    const menu = buildMenuTemplate({
      state,
      statusLabel: state,
      showWindow: () => {},
      requestStop: () => {},
      requestQuit: () => {}
    });
    assert.ok(menu.find(({ label }) => label === "Show Meeting Transcriber"));
    assert.ok(menu.find(({ label }) => label === "Quit Meeting Transcriber"));
  }
});
