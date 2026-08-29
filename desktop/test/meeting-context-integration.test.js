import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AssistController } from "../main/assist-controller.js";
import { getMeetingProfile } from "../main/meeting-profiles.js";
import {
  PROVIDER_LIMITS,
  buildProviderContextPreview,
  buildTranscriptContext,
  createAssistSessionContext,
  normalizeProviderContextSnapshot
} from "../main/provider-policy.js";

const PRIVATE_PACK = Object.freeze({
  id: "pack-private-alpha",
  revision: 7,
  kind: "product_facts",
  name: "Approved product facts",
  content: "Private launch detail: the supported latency target is 80 ms."
});

test("extended provider context strips local identities and exposes an exact metadata-only preview", () => {
  const sessionContext = createAssistSessionContext({
    profile: getMeetingProfile("sales", 1),
    contextPacks: [PRIVATE_PACK]
  });
  const snapshot = makeSnapshot(sessionContext);

  const normalized = normalizeProviderContextSnapshot(snapshot, {
    expectedSessionId: "meeting-context-1"
  });
  const serialized = buildTranscriptContext(normalized);
  const providerPayload = JSON.parse(serialized);
  const preview = buildProviderContextPreview(normalized);

  assert.deepEqual(Object.keys(providerPayload).sort(), [
    "finalizedTranscript",
    "meetingProfile",
    "privateContextPacks"
  ]);
  assert.deepEqual(Object.keys(providerPayload.meetingProfile).sort(), [
    "appGuidance",
    "limitations",
    "name",
    "responseStyle",
    "version"
  ]);
  assert.deepEqual(Object.keys(providerPayload.privateContextPacks[0]).sort(), [
    "category",
    "content",
    "name"
  ]);
  assert.deepEqual(Object.keys(providerPayload.finalizedTranscript[0]).sort(), [
    "endMs",
    "speakerLabel",
    "startMs",
    "text"
  ]);
  assert.doesNotMatch(serialized, /pack-private-alpha|"id"|"revision"/u);

  assert.equal(preview.totalBytes, Buffer.byteLength(serialized, "utf8"));
  assert.deepEqual(preview.profile, {
    name: "Sales",
    version: 1,
    bytes: Buffer.byteLength(JSON.stringify(providerPayload.meetingProfile), "utf8")
  });
  assert.deepEqual(preview.contextPacks, [{
    category: "product_facts",
    name: "Approved product facts",
    bytes: Buffer.byteLength(JSON.stringify(providerPayload.privateContextPacks[0]), "utf8")
  }]);
  assert.deepEqual(preview.transcript, {
    segmentCount: 1,
    bytes: Buffer.byteLength(JSON.stringify(providerPayload.finalizedTranscript), "utf8"),
    startMs: 1_000,
    endMs: 2_000
  });
  assert.doesNotMatch(
    JSON.stringify(preview),
    /pack-private-alpha|Private launch detail|"id"|"revision"/u
  );
});

test("private context preserves exact UTF-8 whitespace and Markdown through provider projection", () => {
  const exactContent = "\n  # Launch notes\r\n\r\n- Keep **Markdown** intact.  \r\n\t- Preserve indentation.\n\n";
  const sessionContext = createAssistSessionContext({
    profile: getMeetingProfile("sales", 1),
    contextPacks: [{
      ...PRIVATE_PACK,
      content: exactContent
    }]
  });
  const normalized = normalizeProviderContextSnapshot(makeSnapshot(sessionContext), {
    expectedSessionId: "meeting-context-1"
  });
  const projected = JSON.parse(buildTranscriptContext(normalized));

  assert.equal(sessionContext.contextPacks[0].content, exactContent);
  assert.equal(normalized.contextPacks[0].content, exactContent);
  assert.equal(projected.privateContextPacks[0].content, exactContent);

  for (const content of [" \n\t ", "unsafe\u0000control", "unpaired \ud800 surrogate"]) {
    assert.throws(() => createAssistSessionContext({
      profile: getMeetingProfile("sales", 1),
      contextPacks: [{ ...PRIVATE_PACK, content }]
    }), { code: "invalid_context" });
  }
});

test("meeting context rejects duplicate, profile-incompatible, and oversized selections", () => {
  const sales = getMeetingProfile("sales", 1);
  assert.throws(() => createAssistSessionContext({
    profile: sales,
    contextPacks: [PRIVATE_PACK, { ...PRIVATE_PACK, revision: 8 }]
  }), { code: "invalid_context" });

  assert.throws(() => createAssistSessionContext({
    profile: sales,
    contextPacks: [{
      ...PRIVATE_PACK,
      id: "pack-private-resume",
      kind: "resume"
    }]
  }), { code: "invalid_context" });

  const individuallyValidButCollectivelyOversized = createAssistSessionContext({
    profile: sales,
    contextPacks: [{
      ...PRIVATE_PACK,
      id: "pack-private-oversized",
      content: "x".repeat(PROVIDER_LIMITS.maxContextPackBytes)
    }]
  });
  const oversizedSnapshot = makeSnapshot(individuallyValidButCollectivelyOversized, {
    segments: Object.freeze([])
  });
  assert.throws(() => buildProviderContextPreview(oversizedSnapshot), {
    code: "provider_context_too_large"
  });
  assert.throws(() => buildTranscriptContext(oversizedSnapshot), {
    code: "provider_context_too_large"
  });
});

test("AssistController keeps exact private context in main while renderer summaries stay metadata-only", () => {
  const sessionContext = createAssistSessionContext({
    profile: getMeetingProfile("sales", 1),
    contextPacks: [PRIVATE_PACK]
  });
  const controller = new AssistController({
    provider: {
      async streamAssist() {
        return (async function* emptyStream() {})();
      }
    }
  });

  controller.startSession("meeting-context-1", sessionContext);
  controller.ingest(finalEvent());

  const summary = controller.getSessionContextSummary();
  assert.deepEqual(summary.contextPacks, [{
    kind: "product_facts",
    name: "Approved product facts",
    bytes: Buffer.byteLength(PRIVATE_PACK.content, "utf8")
  }]);
  assert.equal(Object.hasOwn(summary.contextPacks[0], "id"), false);
  assert.equal(Object.hasOwn(summary.contextPacks[0], "revision"), false);
  assert.equal(Object.hasOwn(summary.contextPacks[0], "content"), false);
  assert.doesNotMatch(JSON.stringify(summary), /pack-private-alpha|Private launch detail/u);

  const requestSnapshot = controller.getRequestContextSnapshot();
  assert.deepEqual(requestSnapshot.profile, sessionContext.profile);
  assert.deepEqual(requestSnapshot.contextPacks, sessionContext.contextPacks);
  assert.equal(requestSnapshot.contextPacks[0].content, PRIVATE_PACK.content);
  assert.equal(Object.isFrozen(requestSnapshot), true);
  assert.equal(Object.isFrozen(requestSnapshot.contextPacks), true);

  controller.freezeContextForRequest();
  assert.equal(controller.endSession("meeting-context-1"), true);
  assert.equal(controller.getSessionContextSummary(), null);
  assert.equal(controller.getRequestContextSnapshot(), null);
});

test("context-pack IPC and preload expose only explicit operations and exact references", async () => {
  const [main, preload] = await Promise.all([
    readFile(new URL("../main/index.js", import.meta.url), "utf8"),
    readFile(new URL("../preload/index.cjs", import.meta.url), "utf8")
  ]);

  assert.match(preload, /start: \(options, assistSelection\) => ipcRenderer\.invoke\("meeting:start", options, assistSelection\)/u);
  assert.match(preload, /getAssistLibrary: \(\) => ipcRenderer\.invoke\("meeting:assist-library"\)/u);
  assert.match(preload, /createContextPack: \(\{ kind, name, content \}\) => ipcRenderer\.invoke\([^]*?\{ kind, name, content \}\s*\)/u);
  assert.match(preload, /updateContextPack: \(\{ id, revision, kind, name, content \}\) => ipcRenderer\.invoke\([^]*?\{ id, revision, kind, name, content \}\s*\)/u);
  assert.match(preload, /deleteContextPack: \(\{ id, revision \}\) => ipcRenderer\.invoke\([^]*?\{ id, revision \}\s*\)/u);

  const startHandler = sliceBetween(
    main,
    'ipcMain.handle("meeting:start"',
    'ipcMain.handle("meeting:audio"'
  );
  assert.match(startHandler, /args\.length !== 0/u);
  assertBefore(startHandler, "resolveAssistSelection(assistSelection)", "await backend.startSession");
  assertBefore(startHandler, "await backend.startSession", "startAssistSession(engine.session_id, sessionContext)");

  const resolver = sliceBetween(
    main,
    "async function resolveAssistSelection",
    "function contextPackPublicError"
  );
  assert.match(resolver, /normalizeMeetingProfileSelection\(input\.profile\)/u);
  assert.match(resolver, /getMeetingProfile\(selection\.profileId, selection\.profileVersion\)/u);
  assert.match(resolver, /contextPackStore\?\.resolveSelection\(input\.contextPacks\)/u);
  assert.match(resolver, /createAssistSessionContext\(\{ profile, contextPacks \}\)/u);
  assert.doesNotMatch(resolver, /input\.(?:content|instruction|responseStyle)/u);

  const library = sliceBetween(
    main,
    "async function getRendererAssistLibrary",
    "async function resolveAssistSelection"
  );
  assert.match(library, /contextPacksAvailable: true[^]*?contextPacks: await contextPackStore\.list\(\)/u);
  assert.match(library, /catch \{[^]*?profiles,[^]*?contextPacksAvailable: false,[^]*?contextPacks: Object\.freeze\(\[\]\)/u);
  assert.doesNotMatch(library, /unlink|writeState|\.create\(|\.delete\(/u);

  for (const [channel, operation] of [
    ["meeting:context-pack-create", "create"],
    ["meeting:context-pack-update", "update"],
    ["meeting:context-pack-delete", "delete"]
  ]) {
    const handler = handlerSlice(main, channel);
    assert.match(handler, /args\.length !== 0/u);
    assert.match(handler, /settingsAreLocked\(\)/u);
    assert.match(handler, new RegExp(`contextPackStore\\.${operation}\\(value\\)`));
    assert.match(handler, /getRendererAssistLibrary\(\)/u);
  }
});

test("renderer freezes the active selection, quick actions only prefill, and an oversized preview blocks Send", async () => {
  const renderer = await readFile(new URL("../renderer/app.js", import.meta.url), "utf8");
  const selectionBuilder = sliceBetween(
    renderer,
    "function buildAssistSelectionForStart",
    "function handleMeetingProfileChange"
  );
  assert.match(selectionBuilder, /Object\.freeze\(\{ id: pack\.id, revision: pack\.revision \}\)/u);
  assert.match(selectionBuilder, /profile: Object\.freeze\(\{ profileId: profile\.id, profileVersion: profile\.version \}\)/u);
  assert.match(selectionBuilder, /contextPacks: Object\.freeze\(contextPacks\)/u);
  assert.doesNotMatch(selectionBuilder, /pack\.(?:content|name)|profile\.(?:instruction|responseStyle)/u);

  const startFlow = sliceBetween(renderer, "async function startSession", "function stopSession");
  const startingRenderFlow = sliceBetween(startFlow, "const previousTranscript", "const startResult =");
  assertBefore(startingRenderFlow, "requestedAssistSelection = buildAssistSelectionForStart()", "renderSession()");
  assertBefore(startingRenderFlow, "activeAssistSelection = requestedAssistSelection", "renderSession()");
  assertBefore(startingRenderFlow, "renderSession()", "await speakerRefreshPromise");
  assert.match(startFlow, /await bridge\.start\(\{[^]*?\}, requestedAssistSelection\)/u);
  assert.match(startFlow, /catch \(error\) \{[^]*?activeAssistSelection = null;[^]*?state\.fail\(issue\.code, issue\.message\);[^]*?renderSession\(\);/u);
  assert.doesNotMatch(startFlow, /assistSelection\s*=/u);

  const quickActions = sliceBetween(
    renderer,
    "function renderAssistQuickActions",
    "function openContextPacksDialog"
  );
  assert.match(quickActions, /button\.title = "Prefill the question\. This does not send anything\."/u);
  assert.match(quickActions, /elements\.assistQuestion\.value = action\.prompt/u);
  assert.match(quickActions, /handleAssistQuestionInput\(\)/u);
  assert.match(quickActions, /elements\.assistQuestion\.focus\(\)/u);
  assert.doesNotMatch(quickActions, /requestAssist|sendAssistRequest|assistSend\.click|bridge\./u);

  const canSend = sliceBetween(renderer, "function canSendAssistRequest", "async function revealAssist");
  assert.match(canSend, /assistStatus\.requestPreview\?\.blocked !== true/u);
  const preview = sliceBetween(renderer, "function renderAssistRequestPreview", "function renderAssistStateBadge");
  assert.match(preview, /if \(preview\?\.blocked\)/u);
  assert.match(preview, /Cannot send:/u);
  assert.match(renderer, /Saved private context could not be loaded and was left untouched\./u);
  assert.match(renderer, /available = secure && assistLibrary\.contextPacksAvailable/u);
  assert.match(renderer, /elements\.contextPackListEmpty\.hidden = !available \|\| assistLibrary\.contextPacks\.length > 0/u);

  const saveContextPack = sliceBetween(
    renderer,
    "async function saveContextPack",
    "async function deleteContextPack"
  );
  assert.match(saveContextPack, /const name = elements\.contextPackName\.value\.trim\(\);/u);
  assert.match(saveContextPack, /const content = elements\.contextPackContent\.value;/u);
  assert.match(saveContextPack, /content\.trim\(\)\.length === 0/u);
  assert.doesNotMatch(saveContextPack, /contextPackContent\.value\.trim\(\)/u);
});

test("status and context-review DTOs cannot expose private pack contents or local identities", async () => {
  const [main, renderer, controller] = await Promise.all([
    readFile(new URL("../main/index.js", import.meta.url), "utf8"),
    readFile(new URL("../renderer/app.js", import.meta.url), "utf8"),
    readFile(new URL("../main/assist-controller.js", import.meta.url), "utf8")
  ]);

  const mainContextDto = sliceBetween(
    main,
    "function buildRendererAssistContext",
    "async function getRendererAssistLibrary"
  );
  assert.match(mainContextDto, /assistController\?\.getSessionContextSummary\(\)/u);
  assert.doesNotMatch(mainContextDto, /snapshot\.(?:profile|contextPacks)|\.content/u);

  const summaryMethod = sliceBetween(
    controller,
    "  getSessionContextSummary()",
    "  async request(value)"
  );
  assert.match(summaryMethod, /kind: pack\.kind[^]*?name: pack\.name[^]*?bytes: Buffer\.byteLength\(pack\.content, "utf8"\)/u);
  assert.doesNotMatch(summaryMethod, /(?:id|revision|content): pack\./u);

  const rendererSummary = sliceBetween(
    renderer,
    "function sanitizeAssistSessionContextSummary",
    "function sanitizeAssistRequestPreview"
  );
  assert.match(rendererSummary, /kind: pack\.kind[^]*?name: requireRendererText\(pack\.name[^]*?bytes: normalizeAssistRevision\(pack\.bytes\)/u);
  assert.doesNotMatch(rendererSummary, /(?:id|revision|content): pack\./u);

  const contextDialog = sliceBetween(
    renderer,
    "function renderAssistContextDialog",
    "async function sendAssistRequest"
  );
  assert.match(contextDialog, /pack\.name[^]*?CONTEXT_KIND_LABELS\[pack\.kind\][^]*?pack\.bytes/u);
  assert.match(contextDialog, /Contents stay hidden in this summary\./u);
  assert.doesNotMatch(contextDialog, /pack\.(?:id|revision|content)/u);
});

function makeSnapshot(sessionContext, { segments = null } = {}) {
  const finalizedSegments = segments ?? Object.freeze([Object.freeze({
    id: "segment-private-1",
    revision: 2,
    start_ms: 1_000,
    end_ms: 2_000,
    track: "system",
    text: "The customer asked about supported latency.",
    language: "en",
    speaker_id: "speaker-1"
  })]);
  return Object.freeze({
    sessionId: "meeting-context-1",
    revision: finalizedSegments.length,
    transcriptChars: finalizedSegments.reduce((total, segment) => total + segment.text.length, 0),
    segments: finalizedSegments,
    profile: sessionContext.profile,
    contextPacks: sessionContext.contextPacks
  });
}

function finalEvent() {
  return {
    type: "final_segment",
    session_id: "meeting-context-1",
    segment: {
      id: "segment-private-1",
      revision: 2,
      start_ms: 1_000,
      end_ms: 2_000,
      track: "system",
      text: "The customer asked about supported latency.",
      partial: false,
      final: true,
      language: "en",
      speaker_id: "speaker-1"
    }
  };
}

function handlerSlice(source, channel) {
  const start = source.indexOf(`ipcMain.handle("${channel}"`);
  assert.notEqual(start, -1, `missing IPC handler: ${channel}`);
  const end = source.indexOf("  ipcMain.handle(", start + 1);
  assert.notEqual(end, -1, `missing handler boundary after: ${channel}`);
  return source.slice(start, end);
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function assertBefore(source, first, second) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.notEqual(firstIndex, -1, `missing source marker: ${first}`);
  assert.notEqual(secondIndex, -1, `missing source marker: ${second}`);
  assert.equal(firstIndex < secondIndex, true, `${first} must occur before ${second}`);
}
