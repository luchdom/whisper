import assert from "node:assert/strict";
import test from "node:test";
import {
  isExactRendererFrame,
  isExactRendererIpcEvent,
  isExactRendererPermissionRequest,
  isTrustedRendererPermissionRequest,
  isTrustedFileOrigin,
  supportsSystemAudio
} from "../main/platform.js";

test("macOS system-audio support matches Electron's native-picker minimum", () => {
  assert.equal(supportsSystemAudio("darwin", "12.6.9"), false);
  assert.equal(supportsSystemAudio("darwin", "13.0.0"), false);
  assert.equal(supportsSystemAudio("darwin", "14.7.6"), false);
  assert.equal(supportsSystemAudio("darwin", "15.4.1"), true);
  assert.equal(supportsSystemAudio("win32", "10.0.26100"), true);
  assert.equal(supportsSystemAudio("linux", "6.12"), false);
});

test("privileged calls require the exact main frame and renderer URL", () => {
  const mainFrame = { url: "file:///app/index.html" };
  const webContents = { mainFrame };
  const trustedEvent = { sender: webContents, senderFrame: mainFrame };
  const sameUrlSubframe = { url: mainFrame.url };

  assert.equal(isExactRendererFrame(mainFrame, mainFrame, mainFrame.url), true);
  assert.equal(isExactRendererFrame(sameUrlSubframe, mainFrame, mainFrame.url), false);
  assert.equal(isExactRendererFrame(mainFrame, mainFrame, "file:///other.html"), false);
  assert.equal(isExactRendererIpcEvent(trustedEvent, webContents, mainFrame.url), true);
  assert.equal(isExactRendererIpcEvent({ ...trustedEvent, senderFrame: sameUrlSubframe }, webContents, mainFrame.url), false);
  assert.equal(isExactRendererIpcEvent({ ...trustedEvent, sender: {} }, webContents, mainFrame.url), false);
});

test("only file origins are trusted for the local renderer permission check", () => {
  assert.equal(isTrustedFileOrigin("file://"), true);
  assert.equal(isTrustedFileOrigin("file:///C:/app/index.html"), true);
  assert.equal(isTrustedFileOrigin("https://example.com"), false);
  assert.equal(isTrustedFileOrigin("not a url"), false);
});

test("microphone permission details require the main frame and reject mismatched document or origin", () => {
  const rendererUrl = "file:///C:/app/index.html";
  const trustedDetails = {
    isMainFrame: true,
    requestingUrl: rendererUrl,
    securityOrigin: "file:///"
  };

  assert.equal(isExactRendererPermissionRequest(trustedDetails, rendererUrl), true);
  assert.equal(isExactRendererPermissionRequest({ ...trustedDetails, isMainFrame: false }, rendererUrl), false);
  assert.equal(
    isExactRendererPermissionRequest({ ...trustedDetails, requestingUrl: "file:///C:/app/frame.html" }, rendererUrl),
    false
  );
  assert.equal(
    isExactRendererPermissionRequest({ ...trustedDetails, securityOrigin: "file:///C:/other" }, rendererUrl),
    false
  );
  assert.equal(isExactRendererPermissionRequest({ ...trustedDetails, securityOrigin: "file://" }, rendererUrl), false);
  assert.equal(isExactRendererPermissionRequest({ ...trustedDetails, securityOrigin: "https://example.com" }, rendererUrl), false);
  assert.equal(isExactRendererPermissionRequest({ isMainFrame: true, requestingUrl: rendererUrl }, rendererUrl), true);
  assert.equal(isExactRendererPermissionRequest({ isMainFrame: true }, rendererUrl), true);
  assert.equal(isExactRendererPermissionRequest(undefined, rendererUrl), false);
});

test("display capture and microphone use distinct permission-detail policies", () => {
  const rendererUrl = "file:///C:/app/index.html";
  const malformedRuntimeDetails = { isMainFrame: false, requestingUrl: "" };

  assert.equal(
    isTrustedRendererPermissionRequest("display-capture", malformedRuntimeDetails, rendererUrl),
    true
  );
  assert.equal(isTrustedRendererPermissionRequest("display-capture", undefined, rendererUrl), true);
  assert.equal(isTrustedRendererPermissionRequest("media", malformedRuntimeDetails, rendererUrl), false);
  assert.equal(isTrustedRendererPermissionRequest("media", undefined, rendererUrl), false);
  assert.equal(isTrustedRendererPermissionRequest("media", { isMainFrame: true }, rendererUrl), true);
  assert.equal(
    isTrustedRendererPermissionRequest("media", {
      isMainFrame: true,
      requestingUrl: rendererUrl,
      securityOrigin: "file:///",
      mediaTypes: []
    }, rendererUrl),
    true
  );
  assert.equal(isTrustedRendererPermissionRequest("notifications", { isMainFrame: true }, rendererUrl), false);
});
