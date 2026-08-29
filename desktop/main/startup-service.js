export const HIDDEN_START_ARGUMENT = "--hidden";

export function createStartupService({
  electronApp,
  platform,
  isPackaged,
  executablePath = process.execPath
} = {}) {
  if (!electronApp
    || typeof electronApp.getLoginItemSettings !== "function"
    || typeof electronApp.setLoginItemSettings !== "function") {
    throw new TypeError("Electron login-item APIs are required.");
  }

  const supported = Boolean(isPackaged && (platform === "win32" || platform === "darwin"));

  function isEnabled() {
    if (!supported) return false;
    try {
      const query = platform === "win32"
        ? { path: executablePath, args: [HIDDEN_START_ARGUMENT] }
        : { type: "mainAppService" };
      return electronApp.getLoginItemSettings(query).openAtLogin === true;
    } catch {
      return false;
    }
  }

  function setEnabled(enabled) {
    if (typeof enabled !== "boolean") throw new TypeError("The launch-at-startup setting is invalid.");
    if (!supported) throw new Error("Launch at sign-in is available in an installed Windows or macOS app.");
    electronApp.setLoginItemSettings(platform === "win32"
      ? { openAtLogin: enabled, path: executablePath, args: [HIDDEN_START_ARGUMENT] }
      : { openAtLogin: enabled, type: "mainAppService" });
    return enabled;
  }

  function wasOpenedAtLogin() {
    if (!supported || platform !== "darwin") return false;
    try {
      return electronApp.getLoginItemSettings({ type: "mainAppService" }).wasOpenedAtLogin === true;
    } catch {
      return false;
    }
  }

  return Object.freeze({ supported, isEnabled, setEnabled, wasOpenedAtLogin });
}

export function isHiddenLaunch(argv) {
  return Array.isArray(argv) && argv.includes(HIDDEN_START_ARGUMENT);
}
