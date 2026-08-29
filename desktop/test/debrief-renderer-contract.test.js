import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function rendererSources() {
  return Promise.all([
    readFile(new URL("../renderer/index.html", import.meta.url), "utf8"),
    readFile(new URL("../renderer/app.js", import.meta.url), "utf8"),
    readFile(new URL("../renderer/styles.css", import.meta.url), "utf8")
  ]);
}

test("the debrief rail is local, original-only, complete, and overt about side effects", async () => {
  const [html, app, styles] = await rendererSources();

  assert.match(html, /id="workspace-panel-debrief" class="workspace-tab-panel debrief-panel"/);
  assert.match(html, /Generated on this device/);
  assert.match(html, /Created on this device from finalized original transcript text\. Nothing is sent automatically\. Portuguese translations stay with the transcript and are not used to create debrief claims\./);
  assert.match(html, />Generate local debrief</);
  assert.match(html, />Copy Markdown</);
  assert.match(html, />Export Markdown…</);
  assert.match(html, />Clear debrief…</);
  assert.match(html, />Delete debrief source data…</);
  assert.match(html, /Nothing is emailed, posted, or turned into tasks automatically\./);

  for (const title of [
    "Summary",
    "Decisions",
    "Action items",
    "Open questions and risks",
    "Important objections and questions",
    "Coaching observations"
  ]) assert.match(app, new RegExp(`title: "${title}"`));

  for (const label of [
    "No debrief yet",
    "Local draft",
    "Generating",
    "Ready for review",
    "Partial — review coverage",
    "Couldn’t create debrief"
  ]) assert.match(app, new RegExp(label));

  assert.match(styles, /\.debrief-panel[^]*?overflow-x: hidden;[^]*?overflow-y: auto;/s);
  assert.match(styles, /\.debrief-item-text[^]*?font-size: 13px;/s);
  assert.match(styles, /\.debrief-local-boundary p[^]*?font-size: 12px;/s);
  assert.match(styles, /\.debrief-action-field select,[^]*?min-height: 34px;/s);
  assert.match(styles, /\.debrief-source-chip[^]*?min-height: 34px;/s);
  assert.match(styles, /\.debrief-item-actions \.secondary-action[^]*?min-height: 34px;/s);
  assert.doesNotMatch(app, /innerHTML/);
});

test("stop exposes explicit local generation after queued finals without using Assist or changing tabs", async () => {
  const [, app] = await rendererSources();
  const stop = app.slice(app.indexOf("async function performStop"), app.indexOf("async function interruptSession"));
  const generate = app.slice(app.indexOf("async function generateLocalDebrief"), app.indexOf("function createTranscriptSourceIndex"));

  assert.match(stop, /if \(stopCompleted\) \{[^]*?setTimeout\(resolve, 0\)[^]*?\}/s);
  assert.match(stop, /if \(shouldGenerateDebrief\) debriefContextAvailable = true;/);
  assert.ok(stop.indexOf("setTimeout(resolve, 0)") < stop.indexOf("debriefContextAvailable = true"));
  assert.doesNotMatch(stop, /generateLocalDebrief\(\)/);
  assert.match(app, /elements\.debriefGenerate\.addEventListener\("click", \(\) => void generateLocalDebrief\(\)\)/);
  assert.match(app, /elements\.debriefCopy\.disabled = generating \|\| !hasDebriefContent/);
  assert.match(app, /Debrief is available after transcription stops\./);
  assert.match(app, /const hasGeneratedDocument = document\.sessionId !== null/);
  assert.match(app, /readyForFirstGeneration/);
  assert.match(generate, /!debriefContextAvailable \|\| state\.active/);
  assert.match(generate, /bridge\.generateLocalDebrief\(\)/);
  assert.match(generate, /debrief\.loadDraft\(result\.debrief/);
  assert.match(generate, /sourceValidator: \(segmentId\) => presentDebriefSource\(sourceIndex\.get\(String\(segmentId\)\)\)/);
  assert.match(generate, /assertOriginalOnlyLocalDebrief\(result\.debrief, sourceIndex\)/);
  assert.match(app, /isDebriefExtractDerivedFromOriginal\(item\.text, segment\.originalText\)/);
  assert.doesNotMatch(app, /segment\.originalText\.includes\(item\.text\)/);
  assert.doesNotMatch(generate, /requestAssist|setAssistConsent|setWorkspaceTab/);
});

test("regeneration cannot silently replace generated content or user edits and removals", async () => {
  const [, app] = await rendererSources();
  const generate = app.slice(app.indexOf("async function generateLocalDebrief"), app.indexOf("function createTranscriptSourceIndex"));
  const replacementGuard = app.slice(app.indexOf("function shouldConfirmDebriefRegeneration"), app.indexOf("function createTranscriptSourceIndex"));

  assert.match(generate, /const currentDocument = debrief\.snapshot\(\)/);
  assert.match(generate, /shouldConfirmDebriefRegeneration\(currentDocument\)/);
  assert.match(generate, /await confirmLocalDeletion\(\{[^]*?title: "Replace this debrief\?"[^]*?including edits and removed items[^]*?confirmLabel: "Replace and generate"[^]*?\}\)/s);
  assert.match(generate, /if \(!confirmed\) return null/);
  assert.ok(generate.indexOf("await confirmLocalDeletion") < generate.indexOf("debrief.beginGeneration"));
  assert.ok(generate.indexOf("debrief.beginGeneration") < generate.indexOf("bridge.generateLocalDebrief"));
  assert.match(replacementGuard, /document\.sessionId !== null/);
  assert.match(replacementGuard, /DEBRIEF_SECTION_IDS\.some\(\(sectionId\) => document\.sections\[sectionId\]\.items\.length > 0\)/);
});

test("a backend-accepted new meeting clears the prior debrief before native capture", async () => {
  const [, app] = await rendererSources();
  const start = app.slice(app.indexOf("async function startSession"), app.indexOf("function stopSession"));

  assert.ok(start.indexOf("await bridge.start") < start.indexOf("debrief.clear()"));
  assert.ok(start.indexOf("debrief.clear()") < start.indexOf("await capture.start"));
  assert.match(start, /debrief\.clear\(\);\s+debriefContextAvailable = false;\s+debriefFeedback = null;/);
});

test("debrief items stay editable, source-linked, and independently clearable", async () => {
  const [html, app] = await rendererSources();
  const sourceFocus = app.slice(app.indexOf("function focusDebriefSource"), app.indexOf("function buildDebriefMarkdown"));
  const transcriptToggle = app.slice(app.indexOf("async function toggleTranscriptView"), app.indexOf("async function generateLocalDebrief"));
  const clearAssist = app.slice(app.indexOf("async function clearAssistResponse"), app.indexOf("function resetAssistRequest"));
  const clearDebrief = app.slice(app.indexOf("async function clearDebrief"), app.indexOf("async function deleteDebriefSourceData"));
  const deleteSourceData = app.slice(app.indexOf("async function deleteDebriefSourceData"), app.indexOf("function confirmLocalDeletion"));

  assert.match(app, /debrief\.updateItem\(sectionId, itemId, patch, \{ sourceValidator: resolveDebriefSource \}\)/);
  assert.match(app, /debrief\.removeItem\(sectionId, itemId\)/);
  assert.doesNotMatch(app, /window\.prompt|debrief\.addItem/);
  assert.doesNotMatch(html, />Add item</);
  assert.match(app, /\[\["stated", "Stated"\], \["proposed", "Proposed"\], \["unknown", "Not stated"\]\]/);
  assert.match(app, /certainty: stated, proposed, or not stated/);
  assert.match(app, /Local extract/);
  assert.match(app, /Local observation/);
  assert.match(app, /Edited by you/);
  assert.match(app, /Source unavailable/);
  assert.match(sourceFocus, /segmentNodes\.get\(String\(segmentId\)\)/);
  assert.match(sourceFocus, /scrollIntoView/);
  assert.match(sourceFocus, /\.focus\(\{ preventScroll: true \}\)/);
  assert.match(sourceFocus, /classList\.add\("source-highlight"\)/);

  assert.match(app, /debrief\.toMarkdown\(\{ sourceResolver: resolveDebriefSource \}\)/);
  assert.match(app, /bridge\.copyDebrief\(buildDebriefMarkdown\(\)\)/);
  assert.match(app, /bridge\.saveDebrief\(buildDebriefMarkdown\(\)\)/);
  assert.match(clearDebrief, /debrief\.clear\(\)/);
  assert.doesNotMatch(clearDebrief, /bridge\./);
  assert.match(clearDebrief, /Retained local source data stays available so you can generate it again/);
  assert.match(deleteSourceData, /bridge\.clearLocalDebrief\(\)/);
  assert.match(deleteSourceData, /debriefContextAvailable = false/);
  assert.match(deleteSourceData, /You will not be able to regenerate it for this meeting/);

  assert.match(html, /id="clear-transcript-view"[^>]*>Clear transcript view…</);
  assert.match(html, /id="clear-assist-response"[^>]*>Clear Copilot response…</);
  assert.match(transcriptToggle, /transcriptViewCleared = true/);
  assert.match(transcriptToggle, /transcriptViewCleared = false/);
  assert.doesNotMatch(transcriptToggle, /transcript\.(?:reset|clear|replace)/);
  assert.match(clearAssist, /assistOutput = null/);
  assert.doesNotMatch(clearAssist, /bridge\.|debrief\.|transcript\./);

  assert.match(html, /id="cancel-local-delete"[^>]*autofocus>Cancel</);
  assert.match(app, /queueMicrotask\(\(\) => elements\.localDeleteCancel\.focus\(\)\)/);
  assert.match(app, /saved Markdown files remain unchanged/i);
  assert.match(app, /Markdown files you already saved remain unchanged/i);
});
