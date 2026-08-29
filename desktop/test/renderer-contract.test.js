import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the hidden attribute always removes reconciled empty-state content", async () => {
  const styles = await readFile(new URL("../renderer/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
});

test("model choices remain legible and the English-only explanation survives the minimum layout", async () => {
  const styles = await readFile(new URL("../renderer/styles.css", import.meta.url), "utf8");
  const minimumLayout = styles.slice(
    styles.indexOf("@media (max-width: 880px)"),
    styles.indexOf("@media (prefers-color-scheme: dark)")
  );

  assert.match(styles, /\.compact-field\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
  assert.doesNotMatch(minimumLayout, /\.field-help/);
});

test("the renderer ships a restrictive inline content security policy", async () => {
  const html = await readFile(new URL("../renderer/index.html", import.meta.url), "utf8");
  assert.match(html, /default-src 'self'/);
  assert.match(html, /script-src 'self'/);
  assert.match(html, /object-src 'none'/);
});

test("the rendered product is English and exposes the functional model, language, and settings controls", async () => {
  const html = await readFile(new URL("../renderer/index.html", import.meta.url), "utf8");

  assert.match(html, /<html lang="en">/);
  assert.match(html, />Meeting Transcriber</);
  assert.match(html, /Private on this device/);
  assert.match(html, />Save copy…</);
  assert.match(html, /<dialog id="settings-dialog"/);
  assert.match(html, /id="diarization-toggle"/);
  assert.match(html, /id="translation-toggle"/);
  assert.match(html, /id="translation-status" class="translation-status" hidden/);
  assert.doesNotMatch(html, /id="translation-status"[^>]*aria-live=/);
  assert.match(html, /id="model-select" aria-describedby="model-helper"><\/select>/);
  assert.match(html, /id="choose-transcript-folder"/);
  assert.match(html, /id="autosave-toggle"/);
  assert.match(html, /id="close-behavior-quit"[^>]*value="quit"[^>]*checked/);
  assert.match(html, /id="close-behavior-tray"[^>]*value="tray"/);
  assert.match(html, /id="minimize-to-tray"/);
  assert.match(html, /id="launch-at-startup"/);
  assert.match(html, /These options never start audio capture\./);
  assert.match(html, /id="model-progress"[^>]*aria-live="polite"[^>]*hidden/);
  assert.match(html, /<progress id="model-progress-bar" max="1" aria-labelledby="model-progress-label"><\/progress>/);
  const languageSelect = html.slice(
    html.indexOf('id="language-select"'),
    html.indexOf('</select>', html.indexOf('id="language-select"'))
  );
  assert.deepEqual(
    [...languageSelect.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]),
    ["auto", "en", "pt"]
  );
  assert.doesNotMatch(html, /<option value="(?:tiny|base|small|medium|turbo|large-v3)/);
  assert.doesNotMatch(html, /Transcri(?:ção|cao)|Configurações|Salvar|Microfone|Áudio da reunião/i);
});

test("the Conversation Weave identity is visible in the renderer and wired into desktop packaging", async () => {
  const [html, styles, main, packageJson] = await Promise.all([
    readFile(new URL("../renderer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../renderer/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../main/index.js", import.meta.url), "utf8"),
    readFile(new URL("../../package.json", import.meta.url), "utf8")
  ]);
  const packaging = JSON.parse(packageJson).build;

  assert.match(html, /<link rel="icon" type="image\/png" href="\.\.\/build\/icon\.png">/);
  assert.match(html, /<img class="app-logo" src="\.\.\/build\/icon\.png" width="48" height="48" alt="">/);
  assert.match(styles, /\.app-logo\s*\{/);
  assert.match(main, /icon: applicationIcon/);
  assert.equal(packaging.win.icon, "desktop/build/icon.ico");
  assert.equal(packaging.mac.icon, "desktop/build/icon.icns");
  assert.equal(packaging.files.includes("desktop/build/icon.png"), true);
});

test("model loading uses honest indeterminate phases and resets when the engine settles", async () => {
  const app = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");

  assert.match(app, /checking_cache: `Checking \$\{modelLabel\} on this device…`/);
  assert.match(app, /downloading: `Downloading \$\{modelLabel\}…`/);
  assert.match(app, /verifying: `Verifying \$\{modelLabel\}…`/);
  assert.match(app, /preparing_speakers: "Preparing anonymous speaker detection…"/);
  for (const phase of [
    "checking_translation_cache", "downloading_translation", "verifying_translation",
    "converting_translation", "initializing_translation"
  ]) assert.match(app, new RegExp(`${phase}:`));
  assert.match(app, /modelProgressBar\.removeAttribute\("value"\)/);
  assert.match(app, /if \(event\.status === "loading"\) showModelProgress/);
  assert.match(app, /else if \(display\) hideModelProgress\(\)/);
  assert.match(app, /backendSessionStarted = false;\s*eventGate\.clear\(\);\s*hideModelProgress\(\);/);
  assert.doesNotMatch(app, /modelProgressBar\.value|percent.*modelProgress/i);
});

test("the preload exposes narrow transcript and settings operations without a generic write or path API", async () => {
  const preload = await readFile(new URL("../preload/index.cjs", import.meta.url), "utf8");

  for (const method of [
    "cancelStart", "saveCopy", "autoSave", "refreshAutoSave", "getSettings", "updateSettings",
    "chooseTranscriptFolder", "clearTranscriptFolder", "getProviderStatus", "importProviderCredential",
    "revokeProviderCredential", "openProviderLink", "reportTrayState", "onTrayAction"
  ]) {
    assert.match(preload, new RegExp(`\\b${method}:`));
  }
  assert.doesNotMatch(preload, /writeFile|readFile|filePath\s*=>|saveToPath|chooseFile/);
  assert.match(preload, /const TRAY_ACTIONS = new Set\(\["focus-start", "stop"\]\)/);
  assert.match(preload, /const PROVIDER_LINKS = new Set\(\["privacy", "data-controls", "usage"\]\)/);
  assert.doesNotMatch(preload, /importProviderCredential:\s*\([^)]/);
  assert.doesNotMatch(preload, /revokeProviderCredential:\s*\([^)]/);
});

test("AI provider settings are overt, lazy, encrypted, and renderer-bounded", async () => {
  const [html, app, main, policy] = await Promise.all([
    readFile(new URL("../renderer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../renderer/app.js", import.meta.url), "utf8"),
    readFile(new URL("../main/index.js", import.meta.url), "utf8"),
    readFile(new URL("../main/provider-policy.js", import.meta.url), "utf8")
  ]);

  assert.equal(html.indexOf('id="provider-settings-heading"') < html.indexOf('id="app-behavior-settings-heading"'), true);
  assert.match(html, /Optionally use a hosted AI model to help with finalized transcript text\. Local transcription stays separate\./);
  assert.match(html, /<fieldset class="choice-group" aria-describedby="provider-settings-description provider-feedback">/);
  assert.match(html, /id="provider-mode-off"[^>]*value="off"[^>]*checked/);
  assert.match(html, /id="provider-mode-openai"[^>]*value="openai"/);
  assert.match(html, /id="provider-mode-local"[^>]*value="local"[^>]*disabled/);
  assert.match(html, /Local model — coming later/);
  assert.match(html, /id="import-provider-credential"[^>]*>Import from clipboard</);
  assert.match(html, /id="revoke-provider-credential"[^>]*>Remove key</);
  assert.doesNotMatch(html, /<input[^>]*(?:api.?key|password)/i);
  assert.match(html, /id="provider-credential-status" role="status" aria-live="polite"/);
  assert.match(app, /function openSettings\(\)[^]*?showModal\(\);\s*void refreshProviderStatus\(\);/);
  assert.equal((app.match(/bridge\.getProviderStatus\(\)/g) ?? []).length, 1);
  assert.match(app, /providerStatus\?\.encryptionAvailable === false/);
  assert.match(app, /providerStatus\?\.removable !== true/);
  assert.match(app, /A saved credential is invalid and needs removal\./);
  assert.match(app, /A saved credential cannot be read and needs removal\./);
  assert.match(app, /providerCard\.hidden = settings\.providerMode !== "openai"[^]*?providerStatus\?\.removable !== true/);
  assert.match(app, /providerStatusPromise = operation\.finally[^]*?renderProviderSettings\(\);\s*return providerStatusPromise;/);
  assert.match(app, /setAttribute\("role", tone === "error" \? "alert" : "status"\)/);
  assert.match(app, /setAttribute\("aria-live", tone === "error" \? "assertive" : "polite"\)/);
  assert.match(app, /providerDisclosureSummary\.textContent = providerStatus\.disclosure\.summary/);
  assert.match(policy, /Selecting OpenAI, choosing a meeting profile, editing private context, or importing a key sends nothing\./);
  assert.match(policy, /API key stays out of the renderer and context pack/);
  assert.match(policy, /main process uses it only to authenticate (?:this|that explicit) OpenAI HTTPS request/);

  assert.match(main, /session\.fromPartition\("meeting-transcriber-openai", \{ cache: false \}\)/);
  assert.match(main, /credentialPath: path\.join\(app\.getPath\("userData"\), "openai-credential\.json"\)/);
  assert.match(main, /fetch: providerSession\.fetch\.bind\(providerSession\)/);
  assert.match(main, /const clipboardValue = clipboard\.readText\("clipboard"\);\s*await providerController\.importCredential\(clipboardValue\.trim\(\)\);/);
  assert.match(main, /clipboard\.readText\("clipboard"\) === clipboardValue\) clipboard\.clear\("clipboard"\)/);
  const importHandler = main.slice(
    main.indexOf('ipcMain.handle("meeting:provider-import-clipboard"'),
    main.indexOf('ipcMain.handle("meeting:provider-revoke"')
  );
  assert.equal(
    importHandler.indexOf("await providerController.importCredential")
      < importHandler.indexOf('clipboard.clear("clipboard")'),
    true,
    "clipboard clearing remains after the awaited successful import"
  );
  assert.match(
    main,
    /\["credential_cleanup_required", "Remove the saved OpenAI API key before importing another key\."\]/
  );
  assert.doesNotMatch(main, /ipcMain\.handle\("meeting:provider-import-clipboard", async \(event,/);
  assert.doesNotMatch(main, /ipcMain\.handle\("meeting:provider-revoke", async \(event,/);
  assert.match(main, /resolveProviderExternalLink\(linkId\)/);
  assert.match(main, /credentialState: status\.credentialState/);
  assert.match(main, /removable: status\.removable/);
  assert.match(main, /Hosted assistance is optional and must never prevent the local[^]*?providerController = null;/);
});

test("meeting assistance is overt, question-only, consent-gated, and isolated from the transcript", async () => {
  const [html, app, styles, main] = await Promise.all([
    readFile(new URL("../renderer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../renderer/app.js", import.meta.url), "utf8"),
    readFile(new URL("../renderer/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../main/index.js", import.meta.url), "utf8")
  ]);

  assert.equal(html.indexOf('id="transcript-heading"') < html.indexOf('id="assist-heading"'), true);
  assert.match(html, />Assist with this meeting</);
  assert.match(html, /finalized transcript text\. Nothing is sent until you choose Send\./);
  assert.match(html, /id="assist-question"[^>]*maxlength="1000"/s);
  assert.match(html, /id="assist-consent" type="checkbox"/);
  assert.match(html, />Send to OpenAI</);
  assert.match(html, /<dialog id="assist-context-dialog"[^>]*aria-labelledby="assist-context-dialog-title"/);
  assert.match(html, /read-only view shows the finalized context available now/);
  assert.match(html, /Send freezes a fresh exact pack immediately before your request/);
  assert.match(html, />Return to question</);
  assert.doesNotMatch(html, /assist-(?:objective|private-context|ephemeral-context)/);

  const sendAssistFunction = app.slice(
    app.indexOf("async function sendAssistRequest"),
    app.indexOf("function createPendingAssistOutput")
  );
  const useContextFunction = app.slice(
    app.indexOf("function useReviewedAssistContext"),
    app.indexOf("async function getExactAssistContext")
  );
  const handleAssistFunction = app.slice(
    app.indexOf("function handleAssistEvent"),
    app.indexOf("async function cancelAssistRequest")
  );
  const cancelAssistFunction = app.slice(
    app.indexOf("async function cancelAssistRequest"),
    app.indexOf("function renderAssistMessage")
  );
  const assistStatusFunction = app.slice(
    app.indexOf("function refreshAssistStatus"),
    app.indexOf("function sanitizeAssistStatus")
  );
  const mainAssistStatusFunction = main.slice(
    main.indexOf("async function getRendererAssistStatus"),
    main.indexOf("function buildAssistContextSummary")
  );
  assert.match(app, /bridge\.requestAssist\(\{ question \}\)/);
  assert.match(app, /elements\.assistSend\.hidden = Boolean\(assistOutput\)/);
  assert.match(sendAssistFunction, /if \(!question \|\| assistRequestPromise \|\| assistOutput\) return/);
  assert.match(app, /&& !assistOutput\s*\n\s*\);/);
  assert.doesNotMatch(app, /bridge\.requestAssist\(\{[^}]*objective|bridge\.requestAssist\(\{[^}]*ephemeralContext/s);
  assert.match(app, /bridge\.setAssistConsent\(desired\)/);
  assert.doesNotMatch(app, /grantAssistConsent|setAssistConsent\(\{/);
  assert.match(app, /bridge\.getAssistContext\(\)/);
  assert.match(sendAssistFunction, /const context = await getExactAssistContext\(\)/);
  const refreshStatus = sendAssistFunction.indexOf("await refreshAssistStatus({ fresh: true })");
  const cancelAfterStatus = sendAssistFunction.indexOf("attempt.throwIfCanceledBeforeDispatch()", refreshStatus);
  const exactContext = sendAssistFunction.indexOf("await getExactAssistContext()", cancelAfterStatus);
  const cancelAfterContext = sendAssistFunction.indexOf("attempt.throwIfCanceledBeforeDispatch()", exactContext);
  const dispatch = sendAssistFunction.indexOf("attempt.markDispatched()", cancelAfterContext);
  const request = sendAssistFunction.indexOf("bridge.requestAssist({ question })", dispatch);
  const terminalWait = sendAssistFunction.indexOf("await attempt.waitForTerminal()", request);
  assert.equal(
    [refreshStatus, cancelAfterStatus, exactContext, cancelAfterContext, dispatch, request, terminalWait]
      .every((index) => index >= 0),
    true,
    "every assistance request lifecycle marker is present"
  );
  assert.equal(
    refreshStatus < cancelAfterStatus
      && cancelAfterStatus < exactContext
      && exactContext < cancelAfterContext
      && cancelAfterContext < dispatch
      && dispatch < request
      && request < terminalWait,
    true,
    "cancellation is checked after preflight awaits and terminal delivery is awaited after dispatch"
  );
  assert.doesNotMatch(sendAssistFunction, /reviewed|cached|assistContextSnapshot/i);
  assert.doesNotMatch(app, /assistReviewedContext|assistContextSnapshot/);
  assert.match(useContextFunction, /closeAssistContextReview\(\)/);
  assert.match(useContextFunction, /elements\.assistQuestion\.focus\(\)/);
  assert.doesNotMatch(useContextFunction, /=\s*context|getExactAssistContext|requestAssist/);
  assert.match(app, /formatTimestamp\(segment\.start_ms\).*formatTimestamp\(segment\.end_ms\).*formatAssistSnapshotSpeaker\(segment\)/);
  assert.match(app, /bridge\.onAssistEvent\(handleAssistEvent\)/);
  assert.equal(
    handleAssistFunction.indexOf("if (!attempt || attempt.closed) return")
      < handleAssistFunction.indexOf("assistEventGate.accepts(event)"),
    true,
    "closed or missing attempts reject late events before gate or output mutation"
  );
  assert.equal(
    handleAssistFunction.indexOf("assistEventGate.accepts(event)")
      < handleAssistFunction.indexOf("attempt.bindStarted(event)"),
    true,
    "attempt identity is bound only after the strict event gate accepts start"
  );
  assert.equal(
    handleAssistFunction.indexOf("attempt.acceptTerminal(event)")
      < handleAssistFunction.lastIndexOf("renderAssist()"),
    true,
    "terminal identity is accepted before output mutation and rendering completes in the same task"
  );
  assert.equal(
    cancelAssistFunction.indexOf("attempt?.cancel()")
      < cancelAssistFunction.indexOf("bridge.cancelAssist()"),
    true,
    "renderer-owned preflight cancellation closes before main-process cancellation"
  );
  assert.match(app, /error instanceof AssistTerminalDeliveryTimeoutError[^]*?assistDeliveryBlockedContext = attempt\.context/s);
  assert.match(app, /assistDeliveryBlockedContext\.contextRevision !== next\.contextRevision[^]*?assistDeliveryBlockedContext = null/s);
  assert.equal(
    mainAssistStatusFunction.indexOf("await getRendererProviderStatus()")
      < mainAssistStatusFunction.indexOf("assistController?.getContextSnapshot()"),
    true,
    "main snapshots Assist context after the awaited provider read"
  );
  assert.match(assistStatusFunction, /assistStatusGate\.accepts\(identity, result\.assist\?\.sessionId\)[^]*?applyAssistStatus/s);
  assert.match(assistStatusFunction, /scheduleAssistStatusRefresh\(\)[^]*?assistStatusGate\.invalidate\(\)[^]*?setTimeout/s);
  assert.match(app, /function beginAssistMeeting\(sessionId\)[^]*?assistStatusGate\.transition\(sessionId\)[^]*?refreshAssistStatus\(\)/s);
  assert.match(app, /handleAssistConsentChange\(\)[^]*?const identity = assistStatusGate\.invalidate\(\)[^]*?await bridge\.setAssistConsent\(desired\)[^]*?assistStatusGate\.isCurrent\(identity\)/s);
  assert.match(app, /function beginAssistMeeting\(sessionId\)[^]*?supersedeAssistRequestForMeetingTransition\(\)[^]*?assistStatusGate\.transition\(sessionId\)/s);
  assert.match(app, /function endAssistMeeting\(sessionId\)[^]*?supersedeAssistRequestForMeetingTransition\(\)[^]*?assistStatusGate\.transition\(null\)/s);
  assert.match(sendAssistFunction, /const meetingIdentity = assistStatusGate\.capture\(\)/);
  assert.match(sendAssistFunction, /catch \(error\)[^]*?assistStatusGate\.isSameSession\(meetingIdentity\)[^]*?if \(!ownsCurrentMeeting\) return/s);
  assert.match(sendAssistFunction, /finally[^]*?const ownsAttempt = assistRequestAttempt === attempt[^]*?if \(assistStatusGate\.isSameSession\(meetingIdentity\)\)[^]*?refreshAssistStatus\(\{ fresh: true \}\)/s);
  assert.match(app, /bridge\.onAssistShortcut\(\(\) => void revealAssist\(\{ focusQuestion: true \}\)\)/);
  assert.match(app, /if \(event\.channel === "suggestion"\) assistOutput\.suggestion \+= event\.delta/);
  assert.match(app, /does not promote provider-generated classifications to\s*\/\/ meeting facts\./s);
  assert.match(app, /assistOutput\.contextSnapshot\.segments/);
  assert.match(app, /Local transcription continues normally\./);
  assert.doesNotMatch(app, /transcript\.(?:reconcile|replace|restore|reset)\([^)]*assist/i);

  assert.match(app, /function isEditableShortcutTarget\(target\)/);
  assert.match(app, /\["INPUT", "TEXTAREA", "SELECT"\]\.includes\(target\.tagName\)/);
  assert.match(app, /target\.closest\("\[contenteditable\]:not\(\[contenteditable='false'\]\)"\)/);
  assert.match(app, /!event\.target\?\.closest\?\.\("dialog"\)/);
  assert.match(styles, /\.assist-panel\s*\{/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\)[^]*?\.assist-progress-mark/s);
});

test("selected settings drive start, successful stop precedes autosave, and failed starts restore transcript aliases", async () => {
  const app = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");
  const startFunction = app.slice(app.indexOf("async function startSession"), app.indexOf("function stopSession"));
  const stopFunction = app.slice(app.indexOf("async function performStop"), app.indexOf("async function interruptSession"));

  assert.match(startFunction, /bridge\.start\(\{\s*model: settings\.model,\s*language: settings\.language,\s*diarization: settings\.diarization,\s*translation: settings\.translation/s);
  assert.match(startFunction, /const previousTranscript = transcript\.snapshot\(\)/);
  assert.match(startFunction, /transcript\.reset\(\)/);
  assert.match(startFunction, /transcript\.restore\(previousTranscript\)/);
  const backendStop = stopFunction.indexOf("await bridge.stop()");
  const autoSave = stopFunction.indexOf("saveFinalTranscriptAutomatically()");
  const clearGeneration = stopFunction.indexOf("eventGate.clear()");
  assert.equal(backendStop < autoSave, true);
  assert.equal(autoSave < clearGeneration, true);
  assert.match(stopFunction, /await new Promise\(\(resolve\) => setTimeout\(resolve, 0\)\)/);
  assert.match(stopFunction, /await settleSpeakerRenameBeforeTransition\(\)/);
  assert.match(stopFunction, /stopCompleted = Boolean\(result\?\.ok\)/);
  assert.match(stopFunction, /if \(stopCompleted\) \{[^]*?setTimeout\(resolve, 0\)/);
  assert.match(stopFunction, /result\?\.ok && result\?\.successful !== false/);
  assert.match(stopFunction, /if \(stoppedSuccessfully && !pendingStopFailure && !stopError && transcript\.hasFinalized\(\)\)/);
  assert.match(stopFunction, /result\?\.successful === false[^]*?stopError = new MeetingUiError\(\s*"incomplete_transcript"/);
  assert.match(stopFunction, /result\?\.message \|\| "The transcript did not finalize completely\. Review the visible text; Save copy exports completed segments only\."/);
  assert.match(app, /if \(failure && !pendingStopFailure\) pendingStopFailure = failure;/);
  assert.match(app, /pendingStopFailure = null;/);
  assert.match(app, /button\.disabled = isSpeakerEditingLocked\(\)/);
  assert.match(app, /querySelectorAll\("\.speaker-label-button"\)[^]*?button\.disabled = isSpeakerEditingLocked\(\)/);
  assert.match(app, /function beginSpeakerRename\(segment\) \{\s*if \(isSpeakerEditingLocked\(\)\) return;/);
  assert.match(app, /return \["starting", "stopping"\]\.includes\(state\.phase\) \|\| autoSaveRefreshPending > 0/);
  assert.match(app, /event\.key === "Enter"/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(startFunction, /await autoSaveRefreshQueue\.whenIdle\(\)/);
  assert.match(app, /autoSaveRefreshQueue\.enqueue\(\(\) => bridge\.refreshAutoSave\(markdown\)\)/);
  assert.match(app, /async function stopForClose\(\)[^]*?await autoSaveRefreshQueue\.whenIdle\(\);\s*await settingsOperationPromise;/);
  assert.match(app, /elements\.action\.disabled = presentation\.disabled[^]*?!settingsReady[^]*?settingsBusy[^]*?autoSaveRefreshPending > 0[^]*?!modelCatalog/);
  assert.match(app, /if \(startPromise \|\| settingsBusy \|\| autoSaveRefreshPending > 0\) return startPromise;/);
  assert.match(app, /bridge\.reportTrayState\(\{ state: nextState \}\)/);
  assert.match(app, /onActivityChange: \(\) => renderSession\(\)/);
  assert.match(app, /deriveTrayState\(\{\s*phase: state\.phase,\s*captureActive: capture\.active,\s*settingsReady,\s*engineReady: isEngineSetupReady\(\),\s*catalogReady: Boolean\(modelCatalog\)/s);
  assert.match(app, /reportTrayState\(capture\.active \? "transcribing" : "stopped"\)/);
  assert.match(app, /if \(action === "focus-start"\)[^]*?elements\.action\.focus\(\)/);
  assert.doesNotMatch(app, /if \(action === "focus-start"\)[^]*?elements\.action\.click\(\)/);
  assert.match(app, /let settingsOperationPromise = Promise\.resolve\(\)/);
  assert.match(app, /function persistSettings\(patch\) \{\s*return runSettingsOperation/);
  assert.match(app, /function runSettingsOperation\(task\)[^]*?settingsBusy = true;\s*renderSession\(\);[^]*?settingsOperationPromise = operation\.then/);
  assert.match(app, /selectedModel\?\.languageMode === "english_only"/);
  assert.doesNotMatch(app, /endsWith\("\.en"\)/);
  assert.match(app, /Brazilian Portuguese translation available\./);
  assert.match(app, /node\.removeAttribute\("aria-label"\)/);
});

test("main owns transcript destinations, resets autosave only after backend start, and unlocks after stop failure", async () => {
  const main = await readFile(new URL("../main/index.js", import.meta.url), "utf8");
  const startHandler = main.slice(main.indexOf('ipcMain.handle("meeting:start"'), main.indexOf('ipcMain.handle("meeting:audio"'));
  const stopHandler = main.slice(main.indexOf('ipcMain.handle("meeting:stop"'), main.indexOf('ipcMain.handle("meeting:copy"'));

  assert.equal(startHandler.indexOf("await backend.startSession") < startHandler.indexOf("resetCurrentAutoSavePath()"), true);
  assert.match(main, /showOpenDialog\(mainWindow, \{\s*title: "Choose transcript folder",\s*properties: \["openDirectory", "createDirectory"\]/s);
  assert.match(main, /showSaveDialog\(mainWindow/);
  assert.doesNotMatch(main, /ipcMain\.handle\([^\n]+filePath/);
  assert.match(stopHandler, /catch \(error\) \{\s*\/\/[^\n]*\n[^]*?meetingInProgress = false;[^]*?successfulStop = false;/);
  assert.match(stopHandler, /successfulStop = hadMeeting && lastSessionStopReason === "stopped"/);
  assert.match(stopHandler, /successful: successfulStop/);
  assert.match(main, /function incompleteStopMessage\(reason\)/);
  assert.match(main, /const RENDERER_CLOSE_READY_TIMEOUT_MS = STOP_TIMEOUT_MS \+ 30_000;/);
  assert.match(main, /return finalizeCloseLifecycle\(\{/);
  assert.match(main, /app\.requestSingleInstanceLock\(\)/);
  assert.match(main, /isHiddenLaunch\(process\.argv\)/);
  assert.match(main, /createTrayController\(\{/);
  assert.match(main, /Never advertise Ready during that bootstrap gap\.[^]*?trayController\.setState\("preparing"\)/);
  assert.match(main, /getWindowCloseAction\(\{/);
  assert.match(main, /function createWindow\(\) \{\s*if \(mainWindow && !mainWindow\.isDestroyed\(\)\) return mainWindow;/);
  assert.match(main, /function showMainWindow[^]*?if \(!desktopBootstrapReady\) \{\s*queueWindowShow\(\{ focusStart, focusAssist \}\);\s*return;/);
  const bootstrap = main.slice(main.indexOf("app.whenReady().then"), main.indexOf('app.on("window-all-closed"'));
  assert.equal(bootstrap.indexOf("registerIpc()") < bootstrap.indexOf("desktopBootstrapReady = true"), true);
  assert.equal(bootstrap.indexOf("createApplicationTray()") < bootstrap.indexOf("desktopBootstrapReady = true"), true);
  assert.equal(bootstrap.indexOf("desktopBootstrapReady = true") < bootstrap.indexOf("createWindow()"), true);
  assert.match(main, /stopBackend: async \(\) => \{[^]*?finally \{[^]*?meetingInProgress = false;[^]*?successfulStop = false;[^]*?resetCurrentAutoSavePath\(\);/);
});

test("window close cancels and stops capture before waiting for a delayed start", async () => {
  const app = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");
  const closeHandler = app.indexOf("async function stopForClose() {");
  const cancel = app.indexOf("startGate.cancelAll();", closeHandler);
  const cancelBackend = app.indexOf("bridge.cancelStart()", closeHandler);
  const stop = app.indexOf("const captureStopPromise = capture.stop()", closeHandler);
  const awaitCancelBackend = app.indexOf("await cancelStartPromise", closeHandler);
  const wait = app.indexOf("if (startPromise) await startPromise", closeHandler);

  assert.notEqual(closeHandler, -1);
  assert.equal(cancel > closeHandler, true);
  assert.equal(cancelBackend > cancel, true);
  assert.equal(stop > cancelBackend, true);
  assert.equal(awaitCancelBackend > stop, true);
  assert.equal(wait > awaitCancelBackend, true);
  assert.match(app, /capture\.start\(selection, \{ signal: startSignal \}\)/);
});
