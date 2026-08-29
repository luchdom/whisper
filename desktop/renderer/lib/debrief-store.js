export const DEBRIEF_SCHEMA_VERSION = 1;

export const DEBRIEF_SECTION_IDS = Object.freeze([
  "summary",
  "decisions",
  "actions",
  "open_questions_risks",
  "objections",
  "coaching"
]);

export const DEBRIEF_LIMITS = Object.freeze({
  maxItemsPerSection: 50,
  maxItemTextChars: 4_000,
  maxSourcesPerItem: 32,
  maxIdentifierChars: 256,
  maxFieldValueChars: 128,
  maxMessageChars: 1_000
});

const DOCUMENT_STATES = new Set(["empty", "manual", "generating", "ready", "partial", "failed"]);
const SECTION_STATES = new Set(["populated", "empty", "not_requested"]);
const PROVENANCE_VALUES = new Set([
  "local_extractive",
  "local_observation",
  "hosted_generated",
  "manual"
]);
const FIELD_STATES = new Set(["stated", "proposed", "unknown"]);
const SECTION_DEFINITIONS = Object.freeze({
  summary: Object.freeze({
    title: "Summary",
    empty: "No extractive summary was available from the included finalized text."
  }),
  decisions: Object.freeze({
    title: "Decisions",
    empty: "No explicit decisions were identified in the included finalized text."
  }),
  actions: Object.freeze({
    title: "Action items",
    empty: "No explicit action items were identified in the included finalized text."
  }),
  open_questions_risks: Object.freeze({
    title: "Open questions and risks",
    empty: "No explicit open questions or risks were identified in the included finalized text."
  }),
  objections: Object.freeze({
    title: "Important objections and questions",
    empty: "No explicit objections were identified in the included finalized text."
  }),
  coaching: Object.freeze({
    title: "Coaching observations",
    empty: "No talk-time or long-monologue observations were available from the included finalized text."
  })
});

export class DebriefStore {
  constructor({ sourceValidator = null } = {}) {
    if (sourceValidator !== null && typeof sourceValidator !== "function") {
      throw new TypeError("sourceValidator must be a function.");
    }
    this.sourceValidator = sourceValidator;
    this.clear();
  }

  clear() {
    this.document = createEmptyDocument();
    this.nextManualItem = 1;
  }

  replace(value, { sourceValidator = this.sourceValidator } = {}) {
    const normalized = normalizeDocument(value, sourceValidator);
    this.document = normalized;
    this.nextManualItem = deriveNextManualItem(normalized);
    return this.snapshot();
  }

  loadDraft(value, options = {}) {
    return this.replace(value, options);
  }

  restore(value, options = {}) {
    return this.replace(value, options);
  }

  snapshot() {
    return cloneDocument(this.document);
  }

  getDocument() {
    return this.snapshot();
  }

  getSection(sectionId) {
    const normalizedSectionId = normalizeSectionId(sectionId);
    return cloneSection(this.document.sections[normalizedSectionId]);
  }

  getItem(sectionId, itemId) {
    const normalizedSectionId = normalizeSectionId(sectionId);
    const normalizedItemId = normalizeIdentifier(itemId, "item ID");
    const item = this.document.sections[normalizedSectionId].items.find(({ id }) => id === normalizedItemId);
    return item ? cloneItem(item) : null;
  }

  hasItems() {
    return countItems(this.document) > 0;
  }

  setState(state, { message = this.document.message } = {}) {
    const normalizedState = normalizeDocumentState(state);
    const normalizedMessage = normalizeOptionalString(message, "debrief message", DEBRIEF_LIMITS.maxMessageChars);
    if (normalizedState === "empty" && this.hasItems()) {
      throw new RangeError("An empty debrief cannot retain items.");
    }
    const candidate = {
      ...this.document,
      state: normalizedState,
      message: normalizedMessage
    };
    assertDocumentStateCoherence(candidate);
    this.document = candidate;
    return this.snapshot();
  }

  beginGeneration(message = "Generating a debrief from finalized meeting text.") {
    return this.setState("generating", { message });
  }

  markFailed(message) {
    return this.setState("failed", {
      message: normalizeRequiredString(message, "failure message", DEBRIEF_LIMITS.maxMessageChars)
    });
  }

  addItem(sectionId, value, { sourceValidator = this.sourceValidator } = {}) {
    const normalizedSectionId = normalizeSectionId(sectionId);
    const section = this.document.sections[normalizedSectionId];
    if (section.items.length >= DEBRIEF_LIMITS.maxItemsPerSection) {
      throw new RangeError(`${SECTION_DEFINITIONS[normalizedSectionId].title} has reached its item limit.`);
    }
    if (!isRecord(value)) throw new TypeError("A debrief item is required.");
    rejectUnknownKeys(value, ["text", "sources", "owner", "due"], "manual debrief item");

    const id = this.#nextManualId();
    const candidate = {
      id,
      text: value.text,
      sources: value.sources ?? [],
      provenance: "manual",
      edited: true,
      ...(normalizedSectionId === "actions"
        ? {
            owner: value.owner ?? unknownField(),
            due: value.due ?? unknownField()
          }
        : {})
    };
    if (normalizedSectionId !== "actions" && ("owner" in value || "due" in value)) {
      throw new TypeError("Owner and due fields are allowed only for action items.");
    }

    const normalizedItem = normalizeItem(candidate, normalizedSectionId, sourceValidator);
    const sections = cloneSectionsForMutation(this.document.sections);
    sections[normalizedSectionId] = {
      state: "populated",
      truncated: section.truncated,
      items: [...section.items.map(cloneItem), normalizedItem]
    };
    this.document = {
      ...this.document,
      state: stateAfterManualMutation(this.document),
      message: mutationMessage(this.document),
      sections
    };
    return cloneItem(normalizedItem);
  }

  updateItem(sectionId, itemId, patch, { sourceValidator = this.sourceValidator } = {}) {
    const normalizedSectionId = normalizeSectionId(sectionId);
    const normalizedItemId = normalizeIdentifier(itemId, "item ID");
    if (!isRecord(patch)) throw new TypeError("A debrief item patch is required.");
    rejectUnknownKeys(patch, ["text", "sources", "owner", "due"], "debrief item patch");
    if (Object.keys(patch).length === 0) throw new TypeError("A debrief item patch cannot be empty.");
    if (normalizedSectionId !== "actions" && ("owner" in patch || "due" in patch)) {
      throw new TypeError("Owner and due fields are allowed only for action items.");
    }

    const section = this.document.sections[normalizedSectionId];
    const index = section.items.findIndex(({ id }) => id === normalizedItemId);
    if (index < 0) throw new RangeError(`Unknown debrief item ID: ${normalizedItemId}`);
    const current = section.items[index];
    const normalizedItem = normalizeItem({
      ...cloneItem(current),
      ...patch,
      id: current.id,
      provenance: current.provenance,
      edited: true
    }, normalizedSectionId, sourceValidator);

    const nextItems = section.items.map((item, itemIndex) => (
      itemIndex === index ? normalizedItem : cloneItem(item)
    ));
    const sections = cloneSectionsForMutation(this.document.sections);
    sections[normalizedSectionId] = {
      state: "populated",
      truncated: section.truncated,
      items: nextItems
    };
    this.document = {
      ...this.document,
      state: stateAfterManualMutation(this.document),
      message: mutationMessage(this.document),
      sections
    };
    return cloneItem(normalizedItem);
  }

  removeItem(sectionId, itemId) {
    const normalizedSectionId = normalizeSectionId(sectionId);
    const normalizedItemId = normalizeIdentifier(itemId, "item ID");
    const section = this.document.sections[normalizedSectionId];
    const nextItems = section.items.filter(({ id }) => id !== normalizedItemId);
    if (nextItems.length === section.items.length) return false;

    const sections = cloneSectionsForMutation(this.document.sections);
    sections[normalizedSectionId] = {
      state: nextItems.length > 0 ? "populated" : "empty",
      truncated: section.truncated,
      items: nextItems.map(cloneItem)
    };
    const nextDocument = { ...this.document, sections };
    this.document = {
      ...nextDocument,
      state: countItems(nextDocument) > 0
        ? stateAfterManualMutation(this.document)
        : emptyStateForContext(this.document),
      message: countItems(nextDocument) > 0 ? mutationMessage(this.document) : emptyMessageForContext(this.document)
    };
    return true;
  }

  setCoachingRequested(requested) {
    if (typeof requested !== "boolean") throw new TypeError("requested must be a boolean.");
    const coaching = this.document.sections.coaching;
    if (!requested && coaching.items.length > 0) {
      throw new RangeError("Remove coaching items before marking coaching as not requested.");
    }
    if (coaching.items.length > 0) return false;
    const sections = cloneSectionsForMutation(this.document.sections);
    sections.coaching = {
      state: requested ? "empty" : "not_requested",
      truncated: false,
      items: []
    };
    const candidate = reconcileStateAfterPreferenceChange({ ...this.document, sections });
    assertDocumentStateCoherence(candidate);
    this.document = candidate;
    return true;
  }

  validateSources(sourceResolver) {
    if (typeof sourceResolver !== "function") throw new TypeError("A source resolver is required.");
    for (const sectionId of DEBRIEF_SECTION_IDS) {
      for (const item of this.document.sections[sectionId].items) {
        for (const source of item.sources) resolveSource(source, sourceResolver, { requireLabel: false });
      }
    }
    return true;
  }

  toMarkdown({ title = "Meeting debrief", sourceResolver = null } = {}) {
    const normalizedTitle = normalizeRequiredString(title, "debrief title", 200);
    if (this.#hasSources() && typeof sourceResolver !== "function") {
      throw new TypeError("A source resolver is required to export source-linked debrief items.");
    }

    const lines = [`# ${escapeMarkdown(normalizedTitle)}`, ""];
    lines.push(`> **Debrief status:** ${formatDocumentState(this.document.state)}`);
    if (this.document.message) lines.push(`> ${escapeMarkdown(this.document.message)}`);
    if (this.document.coverage) lines.push(`> **Coverage:** ${formatCoverage(this.document.coverage)}`);
    lines.push("");

    for (const sectionId of DEBRIEF_SECTION_IDS) {
      const section = this.document.sections[sectionId];
      const definition = SECTION_DEFINITIONS[sectionId];
      lines.push(`## ${definition.title}`, "");
      if (section.state === "not_requested") {
        lines.push("_Not requested._", "");
        continue;
      }
      if (section.items.length === 0) {
        lines.push(`_${definition.empty}_`, "");
        if (section.truncated) {
          lines.push(
            "> _This section reached a local extraction or source-evidence limit; review the transcript._",
            ""
          );
        }
        continue;
      }

      for (const item of section.items) {
        const editLabel = item.edited ? " _(edited)_" : "";
        lines.push(`- ${escapeMarkdown(item.text)}${editLabel}`);
        if (sectionId === "actions") {
          lines.push(`  - Owner: ${formatField(item.owner)}`);
          lines.push(`  - Due: ${formatField(item.due)}`);
        }
        if (item.sources.length > 0) {
          const resolved = item.sources.map((source) => resolveSource(source, sourceResolver, {
            requireLabel: true
          }));
          const label = item.provenance === "manual" ? "Sources" : "Generated sources";
          lines.push(`  - ${label}: ${resolved.map(formatResolvedSource).join("; ")}`);
        }
        lines.push(`  - Provenance: ${formatProvenance(item.provenance)}`);
        lines.push("");
      }
      if (section.truncated) {
        lines.push(
          "> _This section reached a local extraction or source-evidence limit; review the transcript._",
          ""
        );
      }
    }

    return lines.join("\n");
  }

  #nextManualId() {
    let id;
    const existing = new Set(DEBRIEF_SECTION_IDS.flatMap(
      (sectionId) => this.document.sections[sectionId].items.map(({ id: itemId }) => itemId)
    ));
    do {
      id = `manual-${this.nextManualItem}`;
      this.nextManualItem += 1;
    } while (existing.has(id));
    return id;
  }

  #hasSources() {
    return DEBRIEF_SECTION_IDS.some((sectionId) => (
      this.document.sections[sectionId].items.some(({ sources }) => sources.length > 0)
    ));
  }
}

function createEmptyDocument() {
  return {
    schemaVersion: DEBRIEF_SCHEMA_VERSION,
    state: "empty",
    message: "No debrief has been created.",
    sessionId: null,
    contextRevision: null,
    complete: null,
    reason: null,
    coverage: null,
    sections: Object.fromEntries(DEBRIEF_SECTION_IDS.map((sectionId) => [
      sectionId,
      {
        state: sectionId === "coaching" ? "not_requested" : "empty",
        truncated: false,
        items: []
      }
    ]))
  };
}

function normalizeDocument(value, sourceValidator) {
  if (!isRecord(value)) throw new TypeError("A debrief document is required.");
  rejectUnknownKeys(value, [
    "schemaVersion", "state", "message", "sessionId", "contextRevision", "complete", "reason", "coverage", "sections"
  ], "debrief document");
  if (value.schemaVersion !== DEBRIEF_SCHEMA_VERSION) {
    throw new TypeError("Debrief schema version is unsupported.");
  }
  const state = normalizeDocumentState(value.state);
  const message = normalizeOptionalString(value.message, "debrief message", DEBRIEF_LIMITS.maxMessageChars);
  const sessionId = value.sessionId === null
    ? null
    : normalizeIdentifier(value.sessionId, "session ID");
  const contextRevision = value.contextRevision === null
    ? null
    : normalizeInteger(value.contextRevision, "context revision", 0);
  if ((sessionId === null) !== (contextRevision === null)) {
    throw new TypeError("Debrief session and context revision must be present together.");
  }
  if (![null, true, false].includes(value.complete)) throw new TypeError("Debrief completeness is invalid.");
  const reason = normalizeOptionalString(value.reason, "debrief reason", DEBRIEF_LIMITS.maxIdentifierChars);
  if (value.complete !== null && sessionId === null) {
    throw new TypeError("Debrief completeness requires a session.");
  }
  if (value.complete === null && reason !== null) {
    throw new TypeError("Debrief reason requires a completion state.");
  }
  const coverage = value.coverage === null ? null : normalizeCoverage(value.coverage);
  if ((sessionId === null) !== (coverage === null)) {
    throw new TypeError("Debrief coverage requires a session and context revision.");
  }
  const sections = normalizeSections(value.sections, sourceValidator);
  const document = {
    schemaVersion: DEBRIEF_SCHEMA_VERSION,
    state,
    message,
    sessionId,
    contextRevision,
    complete: value.complete,
    reason,
    coverage,
    sections
  };
  assertDocumentStateCoherence(document);
  return document;
}

function normalizeSections(value, sourceValidator) {
  if (!isRecord(value)) throw new TypeError("Debrief sections are required.");
  rejectUnknownKeys(value, DEBRIEF_SECTION_IDS, "debrief sections");
  for (const sectionId of DEBRIEF_SECTION_IDS) {
    if (!(sectionId in value)) throw new TypeError(`Missing debrief section: ${sectionId}`);
  }

  const itemIds = new Set();
  return Object.fromEntries(DEBRIEF_SECTION_IDS.map((sectionId) => {
    const section = value[sectionId];
    if (!isRecord(section)) throw new TypeError(`Debrief section ${sectionId} is invalid.`);
    rejectUnknownKeys(section, ["state", "truncated", "items"], `debrief section ${sectionId}`);
    if (!SECTION_STATES.has(section.state)) throw new TypeError(`Debrief section state is invalid: ${sectionId}`);
    if (typeof section.truncated !== "boolean") {
      throw new TypeError(`Debrief section truncation is invalid: ${sectionId}`);
    }
    if (section.state === "not_requested" && sectionId !== "coaching") {
      throw new TypeError("Only coaching can be not requested.");
    }
    if (!Array.isArray(section.items)) throw new TypeError(`Debrief section items are invalid: ${sectionId}`);
    if (section.items.length > DEBRIEF_LIMITS.maxItemsPerSection) {
      throw new RangeError(`Debrief section exceeds its item limit: ${sectionId}`);
    }
    const items = section.items.map((item) => {
      const normalized = normalizeItem(item, sectionId, sourceValidator);
      if (itemIds.has(normalized.id)) throw new TypeError(`Duplicate debrief item ID: ${normalized.id}`);
      itemIds.add(normalized.id);
      return normalized;
    });
    if ((section.state === "populated") !== (items.length > 0)) {
      throw new TypeError(`Debrief section state does not match its items: ${sectionId}`);
    }
    return [sectionId, { state: section.state, truncated: section.truncated, items }];
  }));
}

function normalizeItem(value, sectionId, sourceValidator) {
  if (!isRecord(value)) throw new TypeError("Debrief item is invalid.");
  const allowedKeys = sectionId === "actions"
    ? ["id", "text", "sources", "provenance", "edited", "owner", "due"]
    : ["id", "text", "sources", "provenance", "edited"];
  rejectUnknownKeys(value, allowedKeys, `debrief ${sectionId} item`);
  const id = normalizeIdentifier(value.id, "item ID");
  const text = normalizeRequiredString(value.text, "item text", DEBRIEF_LIMITS.maxItemTextChars);
  if (!Array.isArray(value.sources)) throw new TypeError("Debrief item sources must be an array.");
  if (value.sources.length > DEBRIEF_LIMITS.maxSourcesPerItem) {
    throw new RangeError("Debrief item exceeds its source limit.");
  }
  const sourceKeys = new Set();
  const sources = value.sources.map((source) => {
    const normalized = normalizeSource(source);
    const key = `${normalized.segment_id}\u0000${normalized.start_ms}\u0000${normalized.end_ms}`;
    if (sourceKeys.has(key)) throw new TypeError("Debrief item contains a duplicate source.");
    sourceKeys.add(key);
    if (sourceValidator !== null && sourceValidator !== undefined) {
      resolveSource(normalized, sourceValidator, { requireLabel: false });
    }
    return normalized;
  });
  if (!PROVENANCE_VALUES.has(value.provenance)) throw new TypeError("Debrief item provenance is invalid.");
  if (typeof value.edited !== "boolean") throw new TypeError("Debrief item edited flag must be a boolean.");
  if (value.provenance === "manual" && value.edited !== true) {
    throw new TypeError("Manual debrief items must be marked edited.");
  }
  if (value.provenance !== "manual" && sources.length === 0) {
    throw new TypeError("Generated debrief items require at least one source.");
  }

  return {
    id,
    text,
    sources,
    provenance: value.provenance,
    edited: value.edited,
    ...(sectionId === "actions"
      ? { owner: normalizeField(value.owner, "owner"), due: normalizeField(value.due, "due") }
      : {})
  };
}

function normalizeSource(value) {
  if (!isRecord(value)) throw new TypeError("Debrief source is invalid.");
  rejectUnknownKeys(value, ["segment_id", "start_ms", "end_ms"], "debrief source");
  const segmentId = normalizeIdentifier(value.segment_id, "source segment ID");
  const startMs = normalizeInteger(value.start_ms, "source start", 0);
  const endMs = normalizeInteger(value.end_ms, "source end", startMs);
  return { segment_id: segmentId, start_ms: startMs, end_ms: endMs };
}

function normalizeField(value, label) {
  if (!isRecord(value)) throw new TypeError(`Debrief action ${label} is required.`);
  rejectUnknownKeys(value, ["state", "value"], `debrief action ${label}`);
  if (!FIELD_STATES.has(value.state)) throw new TypeError(`Debrief action ${label} state is invalid.`);
  if (value.state === "unknown") {
    if (value.value !== null) throw new TypeError(`Unknown debrief action ${label} must have a null value.`);
    return unknownField();
  }
  return {
    state: value.state,
    value: normalizeRequiredString(value.value, `action ${label}`, DEBRIEF_LIMITS.maxFieldValueChars)
  };
}

function normalizeCoverage(value) {
  if (!isRecord(value)) throw new TypeError("Debrief coverage is invalid.");
  const keys = [
    "totalFinalSegments", "includedFinalSegments", "omittedFinalSegments", "totalTranscriptChars",
    "includedTranscriptChars", "truncated", "observedStartMs", "observedEndMs", "includedStartMs",
    "includedEndMs"
  ];
  rejectUnknownKeys(value, keys, "debrief coverage");
  for (const key of keys) {
    if (!(key in value)) throw new TypeError(`Debrief coverage is missing ${key}.`);
  }
  const normalized = {
    totalFinalSegments: normalizeInteger(value.totalFinalSegments, "total final segments", 0),
    includedFinalSegments: normalizeInteger(value.includedFinalSegments, "included final segments", 0),
    omittedFinalSegments: normalizeInteger(value.omittedFinalSegments, "omitted final segments", 0),
    totalTranscriptChars: normalizeInteger(value.totalTranscriptChars, "total transcript characters", 0),
    includedTranscriptChars: normalizeInteger(value.includedTranscriptChars, "included transcript characters", 0),
    truncated: value.truncated,
    observedStartMs: normalizeNullableInteger(value.observedStartMs, "observed start"),
    observedEndMs: normalizeNullableInteger(value.observedEndMs, "observed end"),
    includedStartMs: normalizeNullableInteger(value.includedStartMs, "included start"),
    includedEndMs: normalizeNullableInteger(value.includedEndMs, "included end")
  };
  if (typeof normalized.truncated !== "boolean") throw new TypeError("Debrief coverage truncation is invalid.");
  if (normalized.totalFinalSegments !== normalized.includedFinalSegments + normalized.omittedFinalSegments) {
    throw new TypeError("Debrief coverage segment counts are inconsistent.");
  }
  if (normalized.truncated !== (normalized.omittedFinalSegments > 0)) {
    throw new TypeError("Debrief coverage truncation is inconsistent.");
  }
  if (normalized.includedTranscriptChars > normalized.totalTranscriptChars) {
    throw new TypeError("Debrief coverage character counts are inconsistent.");
  }
  assertCoverageRange(
    normalized.totalFinalSegments,
    normalized.totalTranscriptChars,
    normalized.observedStartMs,
    normalized.observedEndMs,
    "observed"
  );
  assertCoverageRange(
    normalized.includedFinalSegments,
    normalized.includedTranscriptChars,
    normalized.includedStartMs,
    normalized.includedEndMs,
    "included"
  );
  if (
    normalized.includedStartMs !== null
    && (
      normalized.includedStartMs < normalized.observedStartMs
      || normalized.includedEndMs > normalized.observedEndMs
    )
  ) {
    throw new TypeError("Debrief included coverage range must be within the observed range.");
  }
  return normalized;
}

function resolveSource(source, resolver, { requireLabel }) {
  if (typeof resolver !== "function") throw new TypeError("A source resolver is required.");
  const value = resolver(source.segment_id, { ...source });
  if (value === true && !requireLabel) return { ...source, label: null };
  if (!isRecord(value)) throw new RangeError(`Unknown debrief source: ${source.segment_id}`);
  const resolvedId = value.id ?? value.segment_id ?? source.segment_id;
  if (String(resolvedId) !== source.segment_id) {
    throw new RangeError(`Debrief source identity mismatch: ${source.segment_id}`);
  }
  const startMs = value.start_ms ?? value.startMs;
  const endMs = value.end_ms ?? value.endMs;
  if (startMs !== source.start_ms || endMs !== source.end_ms) {
    throw new RangeError(`Debrief source timestamp mismatch: ${source.segment_id}`);
  }
  const labelValue = value.label ?? value.speakerLabel ?? null;
  const label = labelValue === null
    ? null
    : normalizeRequiredString(labelValue, "source label", DEBRIEF_LIMITS.maxFieldValueChars);
  if (requireLabel && label === null) {
    throw new RangeError(`Debrief source label is unavailable: ${source.segment_id}`);
  }
  return { segment_id: source.segment_id, start_ms: startMs, end_ms: endMs, label };
}

function cloneDocument(value) {
  return {
    ...value,
    coverage: value.coverage ? { ...value.coverage } : null,
    sections: Object.fromEntries(DEBRIEF_SECTION_IDS.map((sectionId) => [
      sectionId,
      cloneSection(value.sections[sectionId])
    ]))
  };
}

function cloneSectionsForMutation(sections) {
  return Object.fromEntries(DEBRIEF_SECTION_IDS.map((sectionId) => [
    sectionId,
    cloneSection(sections[sectionId])
  ]));
}

function cloneSection(section) {
  return {
    state: section.state,
    truncated: section.truncated,
    items: section.items.map(cloneItem)
  };
}

function cloneItem(item) {
  return {
    ...item,
    sources: item.sources.map((source) => ({ ...source })),
    ...(item.owner ? { owner: { ...item.owner } } : {}),
    ...(item.due ? { due: { ...item.due } } : {})
  };
}

function assertDocumentStateCoherence(document) {
  const itemCount = countItems(document);
  const partialCoverage = document.coverage?.truncated === true || hasTruncatedSection(document);
  if (document.state === "empty" && itemCount > 0) {
    throw new TypeError("An empty debrief cannot contain items.");
  }
  if (
    document.state === "empty"
    && document.sessionId !== null
    && (document.complete === false || partialCoverage)
  ) {
    throw new TypeError("An empty debrief cannot hide incomplete or truncated meeting context.");
  }
  if (document.state === "manual" && itemCount === 0) {
    throw new TypeError("A manual debrief requires at least one item.");
  }
  if (document.state === "manual" && (document.complete === false || partialCoverage)) {
    throw new TypeError("A manual debrief with incomplete or truncated context must remain partial.");
  }
  if (document.state === "ready") {
    if (itemCount === 0 || document.complete !== true || partialCoverage) {
      throw new TypeError("A ready debrief requires complete, untruncated context and at least one item.");
    }
  }
  if (document.state === "partial") {
    if (document.sessionId === null || (document.complete !== false && !partialCoverage)) {
      throw new TypeError("A partial debrief requires incomplete or truncated meeting context.");
    }
  }
}

function assertCoverageRange(segmentCount, transcriptChars, startMs, endMs, label) {
  if (segmentCount === 0) {
    if (transcriptChars !== 0 || startMs !== null || endMs !== null) {
      throw new TypeError(`Debrief ${label} coverage must be empty when its segment count is zero.`);
    }
    return;
  }
  if (transcriptChars === 0 || startMs === null || endMs === null || endMs < startMs) {
    throw new TypeError(`Debrief ${label} coverage range is inconsistent.`);
  }
}

function reconcileStateAfterPreferenceChange(document) {
  if (document.state !== "partial") return document;
  const stillPartial = document.complete === false
    || document.coverage?.truncated === true
    || hasTruncatedSection(document);
  if (stillPartial) return document;
  const hasItems = countItems(document) > 0;
  return {
    ...document,
    state: hasItems ? (document.complete === true ? "ready" : "manual") : "empty",
    message: hasItems
      ? "The debrief no longer includes a truncated optional coaching evidence window."
      : "No debrief items remain."
  };
}

function hasTruncatedSection(document) {
  return DEBRIEF_SECTION_IDS.some((sectionId) => document.sections[sectionId].truncated);
}

function stateAfterManualMutation(document) {
  if (
    document.state === "partial"
    || document.complete === false
    || document.coverage?.truncated
    || hasTruncatedSection(document)
  ) {
    return "partial";
  }
  if (["empty", "failed", "generating", "ready", "manual"].includes(document.state)) {
    return "manual";
  }
  return document.state;
}

function mutationMessage(document) {
  if (
    document.state === "partial"
    || document.complete === false
    || document.coverage?.truncated
    || hasTruncatedSection(document)
  ) {
    return document.message;
  }
  return "This debrief includes local edits. Review source references before sharing.";
}

function emptyStateForContext(document) {
  if (document.complete === false || document.coverage?.truncated || hasTruncatedSection(document)) {
    return "partial";
  }
  return "empty";
}

function emptyMessageForContext(document) {
  if (document.complete === false || document.coverage?.truncated || hasTruncatedSection(document)) {
    return "No debrief items remain; the retained meeting context is incomplete or partial.";
  }
  return "No debrief items remain.";
}

function countItems(document) {
  return DEBRIEF_SECTION_IDS.reduce(
    (count, sectionId) => count + document.sections[sectionId].items.length,
    0
  );
}

function deriveNextManualItem(document) {
  let largest = 0;
  for (const sectionId of DEBRIEF_SECTION_IDS) {
    for (const { id } of document.sections[sectionId].items) {
      const match = /^manual-(\d+)$/u.exec(id);
      if (match) largest = Math.max(largest, Number(match[1]));
    }
  }
  return largest + 1;
}

function formatDocumentState(state) {
  return {
    empty: "Empty",
    manual: "Manual draft",
    generating: "Generating",
    ready: "Ready for review",
    partial: "Partial — review coverage",
    failed: "Generation failed"
  }[state];
}

function formatCoverage(coverage) {
  const omitted = coverage.omittedFinalSegments > 0
    ? `; ${coverage.omittedFinalSegments} omitted`
    : "";
  const range = coverage.includedStartMs === null
    ? "; no included time range"
    : `; included ${formatTimestamp(coverage.includedStartMs)}–${formatTimestamp(coverage.includedEndMs)}`;
  return `${coverage.includedFinalSegments} of ${coverage.totalFinalSegments} finalized segments${omitted}${range}.`;
}

function formatField(field) {
  const state = field.state === "unknown"
    ? "Not stated"
    : field.state[0].toUpperCase() + field.state.slice(1);
  return field.value === null ? state : `${state} — ${escapeMarkdown(field.value)}`;
}

function formatProvenance(value) {
  return {
    local_extractive: "Local extract",
    local_observation: "Local observable metric",
    hosted_generated: "Hosted AI draft",
    manual: "Manual"
  }[value];
}

function formatResolvedSource(source) {
  return `[${formatTimestamp(source.start_ms)}–${formatTimestamp(source.end_ms)}] ${escapeMarkdown(source.label)}`;
}

function formatTimestamp(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  }
  return [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function unknownField() {
  return { state: "unknown", value: null };
}

function normalizeDocumentState(value) {
  if (!DOCUMENT_STATES.has(value)) throw new TypeError("Debrief document state is invalid.");
  return value;
}

function normalizeSectionId(value) {
  if (!DEBRIEF_SECTION_IDS.includes(value)) throw new RangeError(`Unknown debrief section: ${value}`);
  return value;
}

function normalizeIdentifier(value, label) {
  return normalizeRequiredString(value, label, DEBRIEF_LIMITS.maxIdentifierChars, true);
}

function normalizeRequiredString(value, label, maxLength, rejectControls = false) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (
    normalized.length === 0
    || normalized.length > maxLength
    || (rejectControls && /[\u0000-\u001f\u007f]/u.test(normalized))
  ) {
    throw new TypeError(`${label} must be non-empty and no longer than ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeOptionalString(value, label, maxLength) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000\u007f]/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeInteger(value, label, minimum) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new TypeError(`${label} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function normalizeNullableInteger(value, label) {
  if (value === null) return null;
  return normalizeInteger(value, label, 0);
}

function rejectUnknownKeys(value, allowedKeys, label) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field: ${key}`);
  }
}

function escapeMarkdown(value) {
  return String(value)
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "\\$1");
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
