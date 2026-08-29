import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OVERLAY_SETTINGS,
  OVERLAY_SETTINGS_VERSION,
  clampOverlayBoundsToWorkArea,
  createOverlayRecoveryDto,
  createOverlayResetDto,
  createOverlayWindowPolicy,
  createPersistedOverlaySettings,
  getContentProtectionDisclosure,
  resolveOverlayPlacement,
  sanitizeStoredOverlaySettings,
  validateOverlaySettingsPatch
} from "../main/overlay-policy.js";

const displays = Object.freeze([
  Object.freeze({
    id: 10,
    workArea: Object.freeze({ x: 0, y: 0, width: 1920, height: 1040 }),
    scaleFactor: 1
  }),
  Object.freeze({
    id: 20,
    workArea: Object.freeze({ x: -1280, y: 40, width: 1280, height: 984 }),
    scaleFactor: 1.25
  })
]);

test("stored overlay settings are versioned, exact, and accessible by default", () => {
  assert.deepEqual(sanitizeStoredOverlaySettings(null), DEFAULT_OVERLAY_SETTINGS);
  assert.deepEqual(sanitizeStoredOverlaySettings({
    version: OVERLAY_SETTINGS_VERSION,
    mode: "private",
    opacity: 0.72,
    bounds: { x: 10, y: 20, width: 560, height: 360 },
    displayId: 10
  }), {
    version: OVERLAY_SETTINGS_VERSION,
    mode: "private",
    opacity: 0.72,
    bounds: { x: 10, y: 20, width: 560, height: 360 },
    displayId: 10
  });

  for (const invalid of [
    { ...DEFAULT_OVERLAY_SETTINGS, version: 2 },
    { ...DEFAULT_OVERLAY_SETTINGS, mode: "hidden" },
    { ...DEFAULT_OVERLAY_SETTINGS, opacity: 0.59 },
    { ...DEFAULT_OVERLAY_SETTINGS, opacity: 1.01 },
    { ...DEFAULT_OVERLAY_SETTINGS, opacity: 0.8 },
    { ...DEFAULT_OVERLAY_SETTINGS, displayId: "10" },
    { ...DEFAULT_OVERLAY_SETTINGS, clickThrough: true },
    { mode: "private", opacity: 0.8 }
  ]) {
    assert.deepEqual(sanitizeStoredOverlaySettings(invalid), DEFAULT_OVERLAY_SETTINGS);
  }
});

test("persisted settings never include transient click-through state", () => {
  const persisted = createPersistedOverlaySettings({
    version: 999,
    mode: "private",
    opacity: 0.8,
    bounds: { x: 100, y: 120, width: 600, height: 400 },
    displayId: 20,
    clickThrough: true,
    visible: false
  });

  assert.deepEqual(persisted, {
    version: OVERLAY_SETTINGS_VERSION,
    mode: "private",
    opacity: 0.8,
    bounds: { x: 100, y: 120, width: 600, height: 400 },
    displayId: 20
  });
  assert.equal("clickThrough" in persisted, false);
  assert.equal("visible" in persisted, false);

  assert.equal(createPersistedOverlaySettings({
    mode: "accessible",
    opacity: 0.7
  }).opacity, 1);
});

test("renderer overlay patches allow only bounded persisted preferences", () => {
  assert.deepEqual(validateOverlaySettingsPatch({
    mode: "private",
    opacity: 0.6,
    bounds: { x: -100, y: 20, width: 500, height: 300 },
    displayId: 20
  }), {
    mode: "private",
    opacity: 0.6,
    bounds: { x: -100, y: 20, width: 500, height: 300 },
    displayId: 20
  });
  assert.deepEqual(validateOverlaySettingsPatch({ opacity: 1, bounds: null, displayId: null }), {
    opacity: 1,
    bounds: null,
    displayId: null
  });

  assert.throws(() => validateOverlaySettingsPatch({ opacity: 0.599 }), /between 0.6 and 1/);
  assert.throws(() => validateOverlaySettingsPatch({ opacity: Number.NaN }), /between 0.6 and 1/);
  assert.throws(() => validateOverlaySettingsPatch({ mode: "stealth" }), /mode is invalid/);
  assert.throws(
    () => validateOverlaySettingsPatch({ mode: "accessible", opacity: 0.8 }),
    /fully opaque/
  );
  assert.throws(() => validateOverlaySettingsPatch({ displayId: -1 }), /identifier is invalid/);
  assert.throws(
    () => validateOverlaySettingsPatch({ bounds: { x: 0, y: 0, width: 10, height: 10, scale: 2 } }),
    /bounds are invalid/
  );
  for (const forbidden of ["version", "clickThrough", "contentProtection", "visible"]) {
    assert.throws(
      () => validateOverlaySettingsPatch({ [forbidden]: true }),
      /unsupported field/
    );
  }
});

test("bounds clamp in display-independent pixels, including negative-coordinate displays", () => {
  assert.deepEqual(clampOverlayBoundsToWorkArea(
    { x: -1500, y: -100, width: 1600, height: 1200 },
    displays[1].workArea
  ), {
    x: -1280,
    y: 40,
    width: 1280,
    height: 984
  });
  assert.deepEqual(clampOverlayBoundsToWorkArea(
    { x: 1810, y: 990, width: 500, height: 300 },
    displays[0].workArea
  ), {
    x: 1420,
    y: 740,
    width: 500,
    height: 300
  });
  assert.throws(
    () => clampOverlayBoundsToWorkArea(
      { x: 0.5, y: 0, width: 500, height: 300 },
      displays[0].workArea
    ),
    /bounds are invalid/
  );
});

test("placement recovers missing displays and unsafe bounds without leaving the work area", () => {
  const placement = resolveOverlayPlacement({
    version: OVERLAY_SETTINGS_VERSION,
    mode: "private",
    opacity: 0.7,
    bounds: { x: 4000, y: 4000, width: 900, height: 700 },
    displayId: 99
  }, { displays, primaryDisplayId: 20 });

  assert.deepEqual(placement, {
    version: OVERLAY_SETTINGS_VERSION,
    displayId: 20,
    bounds: { x: -900, y: 324, width: 900, height: 700 },
    recovered: true,
    reasons: ["display_unavailable", "bounds_clamped"]
  });

  const defaultPlacement = resolveOverlayPlacement(DEFAULT_OVERLAY_SETTINGS, {
    displays,
    primaryDisplayId: 10
  });
  assert.deepEqual(defaultPlacement.bounds, { x: 1336, y: 24, width: 560, height: 360 });
  assert.deepEqual(defaultPlacement.reasons, ["default_placement"]);
});

test("reset and recovery DTOs always restore a visible, focusable, non-click-through overlay", () => {
  const reset = createOverlayResetDto({ displays, primaryDisplayId: 10 });
  assert.equal(reset.action, "reset");
  assert.equal(reset.settings.mode, "accessible");
  assert.equal(reset.settings.opacity, 1);
  assert.deepEqual(reset.runtime, {
    visible: true,
    focusRequested: true,
    focusable: true,
    opacity: 1,
    clickThrough: false,
    contentProtection: false,
    skipTaskbar: false
  });
  assert.equal("clickThrough" in reset.settings, false);

  const recovery = createOverlayRecoveryDto({
    version: OVERLAY_SETTINGS_VERSION,
    mode: "private",
    opacity: 0.65,
    bounds: { x: 100, y: 100, width: 500, height: 300 },
    displayId: 10,
    clickThrough: true
  }, { displays, primaryDisplayId: 10 });
  assert.equal(recovery.action, "recover");
  assert.equal(recovery.settings.mode, "accessible");
  assert.equal(recovery.runtime.visible, true);
  assert.equal(recovery.runtime.focusRequested, true);
  assert.equal(recovery.runtime.clickThrough, false);
  assert.equal(recovery.runtime.contentProtection, false);
  assert.equal(recovery.runtime.skipTaskbar, false);
  assert.equal("clickThrough" in recovery.settings, false);
});

test("runtime policy gates private presentation and click-through recovery", () => {
  const privateSettings = createPersistedOverlaySettings({
    mode: "private",
    opacity: 0.65,
    bounds: null,
    displayId: null
  });
  assert.deepEqual(createOverlayWindowPolicy(privateSettings, {
    platform: "win32",
    clickThroughRequested: true,
    recoveryShortcutAvailable: true
  }), {
    mode: "private",
    opacity: 0.65,
    contentProtection: true,
    skipTaskbar: true,
    clickThrough: true,
    focusable: false
  });
  assert.deepEqual(createOverlayWindowPolicy(privateSettings, {
    platform: "darwin",
    clickThroughRequested: true,
    recoveryShortcutAvailable: false
  }), {
    mode: "private",
    opacity: 0.65,
    contentProtection: true,
    skipTaskbar: false,
    clickThrough: false,
    focusable: true
  });
  assert.deepEqual(createOverlayWindowPolicy(DEFAULT_OVERLAY_SETTINGS, {
    platform: "win32",
    clickThroughRequested: true,
    recoveryShortcutAvailable: true
  }), {
    mode: "accessible",
    opacity: 1,
    contentProtection: false,
    skipTaskbar: false,
    clickThrough: false,
    focusable: true
  });
});

test("content-protection disclosure is platform-specific and makes no stealth promise", () => {
  const windows = getContentProtectionDisclosure("win32");
  const mac = getContentProtectionDisclosure("darwin");
  const linux = getContentProtectionDisclosure("linux");

  assert.match(windows.title, /Windows/);
  assert.match(mac.title, /macOS/);
  for (const disclosure of [windows, mac]) {
    assert.equal(disclosure.supported, true);
    assert.match(disclosure.body, /may still appear/i);
    assert.match(disclosure.body, /not stealth/i);
    assert.match(disclosure.body, /not.*guaranteed invisibility/i);
  }
  assert.equal(linux.supported, false);
  assert.match(linux.body, /does not provide/i);
});
