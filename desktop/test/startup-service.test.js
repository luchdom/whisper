import assert from "node:assert/strict";
import test from "node:test";
import {
  HIDDEN_START_ARGUMENT,
  createStartupService,
  isHiddenLaunch
} from "../main/startup-service.js";

function fakeApp({ openAtLogin = false } = {}) {
  const calls = [];
  return {
    calls,
    getLoginItemSettings(options) {
      calls.push(["get", options]);
      return { openAtLogin };
    },
    setLoginItemSettings(options) {
      calls.push(["set", options]);
      openAtLogin = options.openAtLogin;
    }
  };
}

test("installed Windows startup uses an OS login item with hidden launch", () => {
  const electronApp = fakeApp();
  const service = createStartupService({
    electronApp,
    platform: "win32",
    isPackaged: true,
    executablePath: "C:\\Program Files\\Meeting Transcriber\\Meeting Transcriber.exe"
  });

  assert.equal(service.supported, true);
  assert.equal(service.isEnabled(), false);
  assert.equal(service.setEnabled(true), true);
  assert.deepEqual(electronApp.calls.at(-1), ["set", {
    openAtLogin: true,
    path: "C:\\Program Files\\Meeting Transcriber\\Meeting Transcriber.exe",
    args: [HIDDEN_START_ARGUMENT]
  }]);
  assert.equal(service.isEnabled(), true);
  assert.deepEqual(electronApp.calls.at(-1), ["get", {
    path: "C:\\Program Files\\Meeting Transcriber\\Meeting Transcriber.exe",
    args: [HIDDEN_START_ARGUMENT]
  }]);
});

test("installed macOS startup detects an OS login launch and hides the first window", () => {
  const electronApp = fakeApp();
  electronApp.getLoginItemSettings = () => ({ openAtLogin: true, wasOpenedAtLogin: true });
  const service = createStartupService({ electronApp, platform: "darwin", isPackaged: true });
  service.setEnabled(true);
  assert.deepEqual(electronApp.calls.at(-1), ["set", {
    openAtLogin: true,
    type: "mainAppService"
  }]);
  assert.equal(service.wasOpenedAtLogin(), true);
});

test("source builds and unsupported platforms fail closed instead of registering Electron itself", () => {
  const electronApp = fakeApp();
  const sourceService = createStartupService({ electronApp, platform: "win32", isPackaged: false });
  assert.equal(sourceService.supported, false);
  assert.equal(sourceService.isEnabled(), false);
  assert.throws(() => sourceService.setEnabled(true), /installed Windows or macOS app/);
  assert.deepEqual(electronApp.calls, []);
});

test("hidden launch parsing is exact and never implies capture", () => {
  assert.equal(isHiddenLaunch(["app.exe", HIDDEN_START_ARGUMENT]), true);
  assert.equal(isHiddenLaunch(["app.exe", "--hidden-extra"]), false);
  assert.equal(isHiddenLaunch(null), false);
});
