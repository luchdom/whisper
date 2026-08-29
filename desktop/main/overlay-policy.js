export const OVERLAY_SETTINGS_VERSION = 1;
export const OVERLAY_DISCLOSURE_VERSION = "2026-08-29.v1";
export const OVERLAY_MODES = Object.freeze(["accessible", "private"]);
export const OVERLAY_OPACITY_RANGE = Object.freeze({ minimum: 0.6, maximum: 1 });

const MODE_SET = new Set(OVERLAY_MODES);
const PERSISTED_KEYS = Object.freeze([
  "version",
  "mode",
  "opacity",
  "bounds",
  "displayId"
]);
const PERSISTED_KEY_SET = new Set(PERSISTED_KEYS);
const PATCH_KEY_SET = new Set(PERSISTED_KEYS.filter((key) => key !== "version"));
const MAX_DIP_VALUE = 1_000_000;
const DEFAULT_WIDTH = 560;
const DEFAULT_HEIGHT = 360;
const DEFAULT_MARGIN = 24;

export const DEFAULT_OVERLAY_SETTINGS = freezeSettings({
  version: OVERLAY_SETTINGS_VERSION,
  mode: "accessible",
  opacity: 1,
  bounds: null,
  displayId: null
});

const CONTENT_PROTECTION_COPY = Object.freeze({
  win32: Object.freeze({
    version: OVERLAY_DISCLOSURE_VERSION,
    platform: "win32",
    supported: true,
    title: "Screen-capture protection on Windows",
    body: "Private mode asks Windows to exclude this overlay from supported screen-capture methods. The overlay may still appear in some apps or capture methods. This is a privacy aid, not stealth or guaranteed invisibility."
  }),
  darwin: Object.freeze({
    version: OVERLAY_DISCLOSURE_VERSION,
    platform: "darwin",
    supported: true,
    title: "Screen-capture protection on macOS",
    body: "Private mode asks macOS to protect this overlay in supported screen-capture paths. The overlay may still appear in some apps, OS versions, or capture methods. This is a privacy aid, not stealth or guaranteed invisibility."
  }),
  other: Object.freeze({
    version: OVERLAY_DISCLOSURE_VERSION,
    platform: "other",
    supported: false,
    title: "Screen-capture protection unavailable",
    body: "This platform does not provide a supported screen-capture protection path for the overlay. Private mode must not be described as hidden or invisible."
  })
});

export function sanitizeStoredOverlaySettings(value) {
  if (!isStrictPersistedSettings(value)) return cloneSettings(DEFAULT_OVERLAY_SETTINGS);
  return freezeSettings(value);
}

export function createPersistedOverlaySettings(value) {
  const input = isRecord(value) ? value : {};
  const mode = MODE_SET.has(input.mode) ? input.mode : DEFAULT_OVERLAY_SETTINGS.mode;
  return freezeSettings({
    version: OVERLAY_SETTINGS_VERSION,
    mode,
    opacity: mode === "private" && isValidOpacity(input.opacity)
      ? input.opacity
      : DEFAULT_OVERLAY_SETTINGS.opacity,
    bounds: isValidBounds(input.bounds) ? input.bounds : null,
    displayId: isValidDisplayId(input.displayId) ? input.displayId : null
  });
}

export function validateOverlaySettingsPatch(value) {
  if (!isRecord(value)) throw new TypeError("Overlay settings update must be an object.");
  if (Object.keys(value).some((key) => !PATCH_KEY_SET.has(key))) {
    throw new TypeError("Overlay settings update contains an unsupported field.");
  }

  const patch = {};
  if ("mode" in value) {
    if (!MODE_SET.has(value.mode)) throw new TypeError("The overlay mode is invalid.");
    patch.mode = value.mode;
  }
  if ("opacity" in value) {
    if (!isValidOpacity(value.opacity)) {
      throw new TypeError("Overlay opacity must be between 0.6 and 1.");
    }
    patch.opacity = value.opacity;
  }
  if (value.mode === "accessible" && "opacity" in value && value.opacity !== 1) {
    throw new TypeError("Accessible overlay mode must remain fully opaque.");
  }
  if ("bounds" in value) {
    if (value.bounds !== null && !isValidBounds(value.bounds)) {
      throw new TypeError("The overlay bounds are invalid.");
    }
    patch.bounds = value.bounds === null ? null : freezeBounds(value.bounds);
  }
  if ("displayId" in value) {
    if (value.displayId !== null && !isValidDisplayId(value.displayId)) {
      throw new TypeError("The overlay display identifier is invalid.");
    }
    patch.displayId = value.displayId;
  }
  return Object.freeze(patch);
}

export function clampOverlayBoundsToWorkArea(bounds, workArea) {
  if (!isValidBounds(bounds)) throw new TypeError("The overlay bounds are invalid.");
  if (!isValidWorkArea(workArea)) throw new TypeError("The display work area is invalid.");

  const width = Math.min(bounds.width, workArea.width);
  const height = Math.min(bounds.height, workArea.height);
  const maximumX = workArea.x + workArea.width - width;
  const maximumY = workArea.y + workArea.height - height;

  return freezeBounds({
    x: clamp(bounds.x, workArea.x, maximumX),
    y: clamp(bounds.y, workArea.y, maximumY),
    width,
    height
  });
}

export function resolveOverlayPlacement(value, { displays, primaryDisplayId = null } = {}) {
  const availableDisplays = validateDisplays(displays);
  const inputIsValid = isStrictPersistedSettings(value);
  const settings = inputIsValid
    ? freezeSettings(value)
    : cloneSettings(DEFAULT_OVERLAY_SETTINGS);
  const reasons = [];

  if (!inputIsValid && value !== null && value !== undefined) reasons.push("invalid_settings");

  let display = availableDisplays.find(({ id }) => id === settings.displayId);
  if (!display) {
    if (settings.displayId !== null) reasons.push("display_unavailable");
    display = availableDisplays.find(({ id }) => id === primaryDisplayId) ?? availableDisplays[0];
  }

  let bounds;
  if (settings.bounds === null) {
    reasons.push("default_placement");
    bounds = createDefaultBounds(display.workArea);
  } else {
    bounds = clampOverlayBoundsToWorkArea(settings.bounds, display.workArea);
    if (!sameBounds(bounds, settings.bounds)) reasons.push("bounds_clamped");
  }

  return freezePlacement({
    version: OVERLAY_SETTINGS_VERSION,
    displayId: display.id,
    bounds,
    recovered: reasons.length > 0,
    reasons
  });
}

export function createOverlayResetDto(options) {
  const placement = resolveOverlayPlacement(DEFAULT_OVERLAY_SETTINGS, options);
  return freezeRuntimeDto({
    action: "reset",
    settings: {
      ...DEFAULT_OVERLAY_SETTINGS,
      displayId: placement.displayId,
      bounds: placement.bounds
    },
    placement,
    platform: options?.platform
  });
}

export function createOverlayRecoveryDto(value, options) {
  const settings = sanitizeStoredOverlaySettings(value);
  const placement = resolveOverlayPlacement(value, options);
  return freezeRuntimeDto({
    action: "recover",
    settings: {
      ...settings,
      displayId: placement.displayId,
      bounds: placement.bounds
    },
    placement,
    platform: options?.platform
  });
}

export function createOverlayWindowPolicy(value, {
  platform,
  clickThroughRequested = false,
  recoveryShortcutAvailable = false
} = {}) {
  if (typeof clickThroughRequested !== "boolean"
    || typeof recoveryShortcutAvailable !== "boolean") {
    throw new TypeError("Overlay runtime policy flags must be boolean.");
  }

  const settings = sanitizeStoredOverlaySettings(value);
  const privateMode = settings.mode === "private";
  const supportedContentProtection = platform === "win32" || platform === "darwin";
  const clickThrough = privateMode && clickThroughRequested && recoveryShortcutAvailable;

  return Object.freeze({
    mode: settings.mode,
    opacity: privateMode ? settings.opacity : 1,
    contentProtection: privateMode && supportedContentProtection,
    skipTaskbar: privateMode && platform === "win32",
    clickThrough,
    focusable: !clickThrough
  });
}

export function getContentProtectionDisclosure(platform) {
  if (platform === "win32") return CONTENT_PROTECTION_COPY.win32;
  if (platform === "darwin") return CONTENT_PROTECTION_COPY.darwin;
  return CONTENT_PROTECTION_COPY.other;
}

function isStrictPersistedSettings(value) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== PERSISTED_KEYS.length || keys.some((key) => !PERSISTED_KEY_SET.has(key))) {
    return false;
  }
  return value.version === OVERLAY_SETTINGS_VERSION
    && MODE_SET.has(value.mode)
    && isValidOpacity(value.opacity)
    && (value.mode !== "accessible" || value.opacity === 1)
    && (value.bounds === null || isValidBounds(value.bounds))
    && (value.displayId === null || isValidDisplayId(value.displayId));
}

function isValidOpacity(value) {
  return Number.isFinite(value)
    && value >= OVERLAY_OPACITY_RANGE.minimum
    && value <= OVERLAY_OPACITY_RANGE.maximum;
}

function isValidDisplayId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidBounds(value) {
  return isExactRect(value)
    && isDipInteger(value.x)
    && isDipInteger(value.y)
    && isPositiveDipInteger(value.width)
    && isPositiveDipInteger(value.height);
}

function isValidWorkArea(value) {
  return isValidBounds(value);
}

function isExactRect(value) {
  return isRecord(value)
    && Object.keys(value).length === 4
    && Object.keys(value).every((key) => ["x", "y", "width", "height"].includes(key));
}

function isDipInteger(value) {
  return Number.isSafeInteger(value) && Math.abs(value) <= MAX_DIP_VALUE;
}

function isPositiveDipInteger(value) {
  return isDipInteger(value) && value > 0;
}

function validateDisplays(displays) {
  if (!Array.isArray(displays) || displays.length === 0) {
    throw new TypeError("At least one display is required to place the overlay.");
  }

  const seenIds = new Set();
  return Object.freeze(displays.map((display) => {
    if (!isRecord(display)
      || !isValidDisplayId(display.id)
      || !isValidWorkArea(display.workArea)
      || seenIds.has(display.id)) {
      throw new TypeError("The display list is invalid.");
    }
    seenIds.add(display.id);
    return Object.freeze({ id: display.id, workArea: freezeBounds(display.workArea) });
  }));
}

function createDefaultBounds(workArea) {
  const width = Math.min(DEFAULT_WIDTH, workArea.width);
  const height = Math.min(DEFAULT_HEIGHT, workArea.height);
  const horizontalMargin = Math.min(DEFAULT_MARGIN, Math.max(0, workArea.width - width));
  const verticalMargin = Math.min(DEFAULT_MARGIN, Math.max(0, workArea.height - height));
  return freezeBounds({
    x: workArea.x + workArea.width - width - horizontalMargin,
    y: workArea.y + verticalMargin,
    width,
    height
  });
}

function freezeRuntimeDto({ action, settings, placement, platform }) {
  const policy = createOverlayWindowPolicy(settings, { platform });
  return Object.freeze({
    version: OVERLAY_SETTINGS_VERSION,
    action,
    settings: freezeSettings(settings),
    placement,
    runtime: Object.freeze({
      visible: true,
      focusRequested: true,
      focusable: policy.focusable,
      opacity: policy.opacity,
      clickThrough: policy.clickThrough,
      contentProtection: policy.contentProtection,
      skipTaskbar: policy.skipTaskbar
    })
  });
}

function freezeSettings(value) {
  return Object.freeze({
    version: OVERLAY_SETTINGS_VERSION,
    mode: value.mode,
    opacity: value.opacity,
    bounds: value.bounds === null ? null : freezeBounds(value.bounds),
    displayId: value.displayId
  });
}

function cloneSettings(value) {
  return freezeSettings(value);
}

function freezePlacement(value) {
  return Object.freeze({
    version: value.version,
    displayId: value.displayId,
    bounds: freezeBounds(value.bounds),
    recovered: value.recovered,
    reasons: Object.freeze([...value.reasons])
  });
}

function freezeBounds(value) {
  return Object.freeze({
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height
  });
}

function sameBounds(left, right) {
  return left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
