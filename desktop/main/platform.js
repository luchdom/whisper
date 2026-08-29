export function supportsSystemAudio(platform, systemVersion) {
  if (platform === "win32") return true;
  if (platform !== "darwin") return false;
  const macOsMajor = Number.parseInt(String(systemVersion).split(".")[0], 10);
  return Number.isInteger(macOsMajor) && macOsMajor >= 15;
}

export function isTrustedFileOrigin(origin) {
  if (typeof origin !== "string") return false;
  try {
    return new URL(origin).protocol === "file:";
  } catch {
    return false;
  }
}

export function isExactRendererFrame(frame, mainFrame, rendererUrl) {
  return Boolean(frame && frame === mainFrame && frame.url === rendererUrl);
}

export function isExactRendererIpcEvent(event, webContents, rendererUrl) {
  return Boolean(
    event
      && webContents
      && event.sender === webContents
      && isExactRendererFrame(event.senderFrame, webContents.mainFrame, rendererUrl)
  );
}

export function isExactRendererPermissionRequest(details, rendererUrl) {
  if (!details || details.isMainFrame !== true) {
    return false;
  }

  if (details.requestingUrl !== undefined && details.requestingUrl !== rendererUrl) return false;

  if (details.securityOrigin === undefined) return true;

  try {
    const renderer = new URL(rendererUrl);
    const expectedSecurityOrigin = renderer.protocol === "file:" ? "file:///" : renderer.origin;
    return details.securityOrigin === expectedSecurityOrigin;
  } catch {
    return false;
  }
}

export function isTrustedRendererPermissionRequest(permission, details, rendererUrl) {
  if (permission === "display-capture") {
    // The display-media handler separately binds the request to the exact main frame.
    return true;
  }
  if (permission !== "media") return false;
  return isExactRendererPermissionRequest(details, rendererUrl);
}
