import { DEBRIEF_CONTEXT_SCHEMA_VERSION } from "./debrief-context.js";
import {
  DEBRIEF_MAX_ITEM_TEXT_CHARS,
  boundDebriefExtractText,
  containsUnsafeDebriefTextControl,
  hasUnpairedDebriefSurrogate,
  normalizeDebriefText
} from "../shared/debrief-text.js";

export const DEBRIEF_SCHEMA_VERSION = 1;

export const DEBRIEF_SECTION_IDS = Object.freeze([
  "summary",
  "decisions",
  "actions",
  "open_questions_risks",
  "objections",
  "coaching"
]);

export const DEBRIEF_EXTRACTOR_LIMITS = Object.freeze({
  maxSummaryItems: 3,
  maxItemsPerSection: 12,
  maxItemTextChars: DEBRIEF_MAX_ITEM_TEXT_CHARS,
  maxSourcesPerItem: 32,
  maxStatements: 20_000,
  longMonologueMs: 60_000
});

const ACTION_NEGATION = /\b(?:will\s+not|won['’]t|would\s+not|wouldn['’]t|should\s+not|shouldn['’]t|do\s+not|don['’]t|does\s+not|doesn['’]t|did\s+not|didn['’]t|cannot|can['’]t|not\s+going\s+to|not\s+planning\s+to|no\s+need\s+to|no\s+action|sem\s+ação|não\s+(?:vou|vamos|vai|irá|iremos|preciso|precisamos|precisa|devo|devemos)|não\s+é\s+preciso|não\s+precisa)\b/iu;
const DECISION_NEGATION = /\b(?:did\s+not|didn['’]t|have\s+not|haven['’]t|has\s+not|hasn['’]t|not)\s+(?:decide|decided|agree|agreed)|\b(?:no\s+decision|undecided|não\s+(?:decidimos|concordamos|foi\s+decidido)|nenhuma\s+decisão)\b/iu;
const EXPLICIT_ACTION_PREFIX = /^(?:action\s+item|action|todo|to-do|follow[- ]?up|next\s+step|ação|tarefa|próximo\s+passo)\s*[:—-]/iu;
const ACTION_CUE = /\b(?:(?:i|we|you|he|she|they)\s+(?:will|['’]ll|plan(?:s)?\s+to|agreed?\s+to|commit(?:s|ted)?\s+to|need(?:s)?\s+to)|please\s+[\p{L}]|(?:eu|nós|a\s+gente|ele|ela|eles|elas)\s+(?:vou|vamos|vai|irão|irá|preciso|precisamos|precisa|devo|devemos)|(?:ficou|fica)\s+responsável\s+por)\b/iu;
const NAMED_ACTION_CUE = /^([\p{Lu}][\p{L}\p{M}'’.-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’.-]*){0,2})\s+(?:will|plans?\s+to|agreed?\s+to|committed?\s+to|needs?\s+to|vai|irá)(?=\s|[.,!?;:]|$)/u;
const DECISION_PREFIX = /^(?:decision|decisão)\s*[:—-]/iu;
const DECISION_CUE = /\b(?:we\s+(?:decided|agreed)|the\s+team\s+(?:decided|agreed)|it\s+was\s+decided|we(?:['’]ll|\s+will)\s+(?:go|proceed|move\s+forward)\s+with|decidimos|concordamos|ficou\s+decidid[oa]|foi\s+(?:decidido|acordado))\b/iu;
const OPEN_QUESTION_RISK_CUE = /\b(?:open\s+question|unresolved\s+question|risk|risky|blocker|blocked|concern|uncertain|uncertainty|depends?\s+on|questão\s+em\s+aberto|pergunta\s+em\s+aberto|questão\s+não\s+resolvida|risco|bloqueio|impedimento|preocupação|incert[oa]|depende\s+d[eo])\b/iu;
const OPEN_QUESTION_FORM = /\b(?:what\s+remains|what\s+is\s+(?:blocked|blocking|unresolved|unknown)|what\s+are\s+the\s+risks|who\s+will|who\s+owns|when\s+will|what\s+is\s+the\s+deadline|do\s+we\s+know|have\s+we\s+decided|o\s+que\s+(?:falta|permanece|está\s+bloqueado)|quem\s+(?:vai|é\s+responsável)|qual\s+é\s+o\s+prazo|já\s+decidimos)\b[^?]*\?$/iu;
const RISK_NEGATION_OR_RESOLUTION = /\b(?:no|without)\s+(?:material\s+)?(?:risk|blocker|concern|uncertainty)|\bnot\s+(?:blocked|a\s+risk|a\s+concern|uncertain)|\bno\s+longer\s+(?:blocked|a\s+risk|a\s+concern|uncertain)|\b(?:risk|blocker|concern|uncertainty)\s+(?:is|was|has\s+been)\s+(?:resolved|closed|cleared|mitigated|addressed)|\b(?:we|i|they|the\s+team)\s+(?:resolved|closed|cleared|mitigated|addressed)\s+(?:the\s+)?(?:risk|blocker|concern|uncertainty)|\b(?:sem|nenhum|nenhuma)\s+(?:risco|bloqueio|impedimento|preocupação|incerteza)|\bnão\s+(?:estamos|está|estou)\s+(?:bloquead[oa]s?|impedid[oa]s?|preocupad[oa]s?|incert[oa]s?)|\b(?:risco|bloqueio|impedimento|preocupação|incerteza)\s+(?:foi|está)\s+(?:resolvid[oa]|encerrad[oa]|mitigad[oa]|tratad[oa])|\b(?:resolvemos|encerramos|mitigamos|tratamos)\s+(?:o|a)\s+(?:risco|bloqueio|impedimento|preocupação|incerteza)\b/iu;
const OBJECTION_CUE = /\b(?:i\s+(?:disagree|object)|we\s+disagree|objection|pushback|push\s+back|not\s+convinced|won['’]t\s+work|will\s+not\s+work|strong\s+concern|discordo|discordamos|objeção|contraponto|não\s+estou\s+convencid[oa]|não\s+vai\s+funcionar|preocupação\s+séria)\b/iu;
const FILLER_ONLY = /^(?:hi|hello|hey|thanks|thank\s+you|okay|ok|right|sure|sim|oi|olá|obrigad[oa]|beleza|certo)[.!?]*$/iu;
const OWNER_LABEL = /\b(?:owner|responsible|responsável)\s*[:=-]\s*([\p{Lu}][\p{L}\p{M}'’.-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’.-]*){0,2})/u;
const STATED_NAMED_OWNER = /^([\p{Lu}][\p{L}\p{M}'’.-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’.-]*){0,2})\s+(?:will|plans?\s+to|agreed?\s+to|committed?\s+to|needs?\s+to|vai|irá)(?=\s|[.,!?;:]|$)/u;
const PROPOSED_NAMED_OWNER = /^([\p{Lu}][\p{L}\p{M}'’.-]*(?:\s+[\p{Lu}][\p{L}\p{M}'’.-]*){0,2})\s+(?:should|could|deveria|poderia)\b/u;
const RESERVED_OWNER_WORDS = new Set([
  "action", "decision", "follow", "next", "todo", "ação", "decisão", "próximo",
  "i", "we", "you", "he", "she", "they", "eu", "nós", "ele", "ela", "eles", "elas",
  "it", "this", "that", "meeting", "report", "project", "task", "isso", "isto", "reunião",
  "relatório", "projeto", "tarefa"
]);

export function extractLocalDebrief(contextSnapshot, { includeCoaching = true } = {}) {
  if (typeof includeCoaching !== "boolean") {
    throw new TypeError("includeCoaching must be a boolean.");
  }

  const context = normalizeContextSnapshot(contextSnapshot);
  const statementResult = createStatements(context.segments);
  const statements = statementResult.items;
  const decisions = createMatchedItems(statements, "decisions", isDecision);
  const actions = createActionItems(statements);
  const openQuestionsRisks = createMatchedItems(
    statements,
    "open_questions_risks",
    isOpenQuestionOrRisk
  );
  const objections = createMatchedItems(statements, "objections", isObjection);
  const coaching = includeCoaching ? createCoachingItems(context.segments) : null;
  const sections = {
    summary: createSection(
      createSummaryItems(statements, "summary"),
      null,
      statementResult.truncated
    ),
    decisions: createSection(decisions.items, null, decisions.truncated || statementResult.truncated),
    actions: createSection(actions.items, null, actions.truncated || statementResult.truncated),
    open_questions_risks: createSection(
      openQuestionsRisks.items,
      null,
      openQuestionsRisks.truncated || statementResult.truncated
    ),
    objections: createSection(
      objections.items,
      null,
      objections.truncated || statementResult.truncated
    ),
    coaching: includeCoaching
      ? createSection(coaching.items, null, coaching.truncated)
      : createSection([], "not_requested", false)
  };

  const itemCount = DEBRIEF_SECTION_IDS.reduce(
    (count, sectionId) => count + sections[sectionId].items.length,
    0
  );
  const extractionTruncated = DEBRIEF_SECTION_IDS.some((sectionId) => sections[sectionId].truncated);
  const state = deriveDocumentState(context, itemCount, extractionTruncated);

  return Object.freeze({
    schemaVersion: DEBRIEF_SCHEMA_VERSION,
    state,
    message: stateMessage(state, context, extractionTruncated),
    sessionId: context.sessionId,
    contextRevision: context.revision,
    complete: context.complete,
    reason: context.reason,
    coverage: freezeCoverageClone(context.coverage),
    sections: Object.freeze(sections)
  });
}

function createSummaryItems(statements, sectionId) {
  const candidates = statements.filter(({ text }) => text.length >= 10 && !FILLER_ONLY.test(text));
  if (candidates.length <= DEBRIEF_EXTRACTOR_LIMITS.maxSummaryItems) {
    return candidates.map((statement, index) => createItem(sectionId, index, statement));
  }

  const candidateIndexes = [0, Math.floor((candidates.length - 1) / 2), candidates.length - 1];
  return [...new Set(candidateIndexes)].map((candidateIndex, itemIndex) => (
    createItem(sectionId, itemIndex, candidates[candidateIndex])
  ));
}

function createMatchedItems(statements, sectionId, predicate) {
  const seen = new Set();
  const items = [];
  let truncated = false;
  for (const statement of statements) {
    if (!predicate(statement.text)) continue;
    const key = statement.text.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    if (items.length >= DEBRIEF_EXTRACTOR_LIMITS.maxItemsPerSection) {
      truncated = true;
      break;
    }
    items.push(createItem(sectionId, items.length, statement));
  }
  return { items, truncated };
}

function createActionItems(statements) {
  const seen = new Set();
  const items = [];
  let truncated = false;
  for (const statement of statements) {
    if (!isAction(statement.text)) continue;
    const key = statement.text.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    if (items.length >= DEBRIEF_EXTRACTOR_LIMITS.maxItemsPerSection) {
      truncated = true;
      break;
    }
    items.push(createItem("actions", items.length, statement, {
      owner: extractOwner(statement.text),
      due: extractDue(statement.text)
    }));
  }
  return { items, truncated };
}

function createCoachingItems(segments) {
  const items = [];
  const speakingSegments = segments.filter((segment) => segment.end_ms > segment.start_ms);
  const evidenceSegments = speakingSegments.slice(-DEBRIEF_EXTRACTOR_LIMITS.maxSourcesPerItem);
  const totalSpeakingMs = evidenceSegments.reduce(
    (total, segment) => total + segment.end_ms - segment.start_ms,
    0
  );
  const microphoneSegments = evidenceSegments.filter(({ track }) => track === "microphone");
  const microphoneMs = microphoneSegments.reduce(
    (total, segment) => total + segment.end_ms - segment.start_ms,
    0
  );
  const participantKeys = new Set(evidenceSegments.map(participantKey));

  if (microphoneMs > 0 && totalSpeakingMs > 0 && participantKeys.size > 1) {
    const percent = Math.round(microphoneMs / totalSpeakingMs * 100);
    const scope = speakingSegments.length > evidenceSegments.length
      ? `Within the most recent ${evidenceSegments.length} source-linked finalized speaking segments, your`
      : "Your";
    items.push(createSyntheticItem(
      "coaching",
      items.length,
      `${scope} microphone track accounts for about ${percent}% of the included finalized speaking time.`,
      evidenceSegments
    ));
  }

  const longest = speakingSegments.reduce((current, segment) => {
    if (!current) return segment;
    return segment.end_ms - segment.start_ms > current.end_ms - current.start_ms ? segment : current;
  }, null);
  if (longest && longest.end_ms - longest.start_ms >= DEBRIEF_EXTRACTOR_LIMITS.longMonologueMs) {
    const durationSeconds = Math.round((longest.end_ms - longest.start_ms) / 1_000);
    const subject = longest.track === "microphone" ? "Your longest finalized segment" : "The longest finalized meeting-audio segment";
    items.push(createSyntheticItem(
      "coaching",
      items.length,
      `${subject} lasted about ${formatDuration(durationSeconds)}.`,
      [longest]
    ));
  }

  return {
    items: items.slice(0, DEBRIEF_EXTRACTOR_LIMITS.maxItemsPerSection),
    truncated: speakingSegments.length > evidenceSegments.length
  };
}

function createStatements(segments) {
  const statements = [];
  let truncated = false;
  outer:
  for (const segment of segments) {
    for (const text of splitStatements(segment.text)) {
      if (statements.length >= DEBRIEF_EXTRACTOR_LIMITS.maxStatements) {
        truncated = true;
        break outer;
      }
      statements.push({ text, segment });
    }
  }
  return { items: statements, truncated };
}

function splitStatements(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return [];
  return normalized
    .split(/(?<=[.!?])\s+|\s*[\r\n]+\s*/u)
    .map((entry) => boundedText(entry))
    .filter(Boolean);
}

function isAction(text) {
  if (ACTION_NEGATION.test(text)) return false;
  if (text.endsWith("?") && !EXPLICIT_ACTION_PREFIX.test(text)) return false;
  const namedOwner = text.match(NAMED_ACTION_CUE)?.[1] ?? null;
  return EXPLICIT_ACTION_PREFIX.test(text)
    || ACTION_CUE.test(text)
    || (namedOwner !== null && !isReservedOwner(namedOwner));
}

function isDecision(text) {
  return !DECISION_NEGATION.test(text) && (DECISION_PREFIX.test(text) || DECISION_CUE.test(text));
}

function isOpenQuestionOrRisk(text) {
  if (RISK_NEGATION_OR_RESOLUTION.test(text)) return false;
  return OPEN_QUESTION_RISK_CUE.test(text) || OPEN_QUESTION_FORM.test(text);
}

function isObjection(text) {
  return OBJECTION_CUE.test(text);
}

function extractOwner(text) {
  const labelled = text.match(OWNER_LABEL)?.[1];
  if (labelled) return fieldValue("stated", labelled);

  const assignment = text.replace(EXPLICIT_ACTION_PREFIX, "").trim();
  const stated = assignment.match(STATED_NAMED_OWNER)?.[1];
  if (stated && !isReservedOwner(stated)) return fieldValue("stated", stated);

  const proposed = assignment.match(PROPOSED_NAMED_OWNER)?.[1];
  if (proposed && !isReservedOwner(proposed)) return fieldValue("proposed", proposed);

  return fieldValue("unknown", null);
}

function extractDue(text) {
  const labelled = text.match(/\b(?:due(?:\s+date)?|deadline|prazo)\s*[:=-]\s*([^,.;!?]{1,80})/iu)?.[1];
  if (labelled) return fieldValue(isTentative(text) ? "proposed" : "stated", labelled.trim());

  const relative = text.match(
    /\b(?:by|before|until|até|antes\s+de)\s+((?:today|tomorrow|tonight|eod|end\s+of\s+(?:the\s+)?(?:day|week|month)|next\s+[\p{L}]+|(?:mon|tues|wednes|thurs|fri|satur|sun)day|hoje|amanhã|fim\s+d[oa]\s+(?:dia|semana|mês)|próxim[oa]\s+[\p{L}]+|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}-\d{2}-\d{2}))/iu
  )?.[1];
  if (relative) return fieldValue(isTentative(text) ? "proposed" : "stated", relative.trim());

  return fieldValue("unknown", null);
}

function isTentative(text) {
  return /\b(?:maybe|perhaps|tentative|target|aim|ideally|could|should|talvez|provisóri[oa]|meta|idealmente|poderia|deveria)\b/iu.test(text);
}

function isReservedOwner(value) {
  return RESERVED_OWNER_WORDS.has(value.toLocaleLowerCase("en-US"));
}

function createItem(sectionId, index, statement, fields = {}) {
  return freezeItem({
    id: `local-${sectionId}-${index + 1}`,
    text: boundedText(statement.text),
    sources: [sourceFromSegment(statement.segment)],
    provenance: "local_extractive",
    edited: false,
    ...fields
  });
}

function createSyntheticItem(sectionId, index, text, sourceSegments) {
  return freezeItem({
    id: `local-${sectionId}-${index + 1}`,
    text,
    sources: sourceSegments
      .slice(0, DEBRIEF_EXTRACTOR_LIMITS.maxSourcesPerItem)
      .map(sourceFromSegment),
    provenance: "local_observation",
    edited: false
  });
}

function createSection(items, forcedState = null, truncated = false) {
  return Object.freeze({
    state: forcedState ?? (items.length > 0 ? "populated" : "empty"),
    truncated,
    items: Object.freeze(items)
  });
}

function freezeItem(item) {
  return Object.freeze({
    ...item,
    sources: Object.freeze(item.sources),
    ...(item.owner ? { owner: Object.freeze(item.owner) } : {}),
    ...(item.due ? { due: Object.freeze(item.due) } : {})
  });
}

function sourceFromSegment(segment) {
  return Object.freeze({
    segment_id: segment.id,
    start_ms: segment.start_ms,
    end_ms: segment.end_ms
  });
}

function participantKey(segment) {
  if (segment.track === "microphone") return "microphone";
  return segment.speaker_id ? `speaker:${segment.speaker_id}` : "system";
}

function fieldValue(state, value) {
  return { state, value };
}

function deriveDocumentState(context, itemCount, extractionTruncated) {
  if (context.state === "active" || context.coverage.truncated || extractionTruncated) return "partial";
  if (!context.complete) return context.segments.length > 0 ? "partial" : "failed";
  return itemCount > 0 ? "ready" : "empty";
}

function stateMessage(state, context, extractionTruncated) {
  if (state === "partial") {
    if (extractionTruncated) {
      return "This local draft reached an extraction or source-evidence limit; review the transcript and truncated sections before sharing.";
    }
    if (context.complete && context.coverage.truncated) {
      return "This local extract covers only the retained finalized-text window shown in coverage.";
    }
    return context.state === "active"
      ? "This draft covers finalized text captured so far; the meeting has not stopped."
      : `This draft covers completed segments from an incomplete meeting (${context.reason ?? "unknown reason"}).`;
  }
  if (state === "failed") {
    return `No finalized text was available from the incomplete meeting (${context.reason ?? "unknown reason"}).`;
  }
  if (state === "empty") return "No finalized meeting text was available to debrief.";
  return "This local extract covers the retained finalized meeting text.";
}

function normalizeContextSnapshot(value) {
  if (!isRecord(value) || value.schemaVersion !== DEBRIEF_CONTEXT_SCHEMA_VERSION) {
    throw new TypeError("A supported debrief context snapshot is required.");
  }
  if (!new Set(["active", "complete", "incomplete"]).has(value.state)) {
    throw new TypeError("Debrief context state is invalid.");
  }
  const sessionId = normalizeIdentifier(value.sessionId, "context session ID", 256);
  const revision = normalizeInteger(value.revision, "context revision", 0);
  if (typeof value.complete !== "boolean" || value.complete !== (value.state === "complete")) {
    throw new TypeError("Debrief context completion state is inconsistent.");
  }
  const reason = value.reason === null
    ? null
    : normalizeIdentifier(value.reason, "context reason", 256);
  if (value.state === "active" && reason !== null) {
    throw new TypeError("An active debrief context cannot have a stop reason.");
  }
  if (value.state !== "active" && reason === null) {
    throw new TypeError("A finalized debrief context requires a stop reason.");
  }
  if (!Array.isArray(value.segments)) throw new TypeError("Debrief context segments are required.");

  const ids = new Set();
  const segments = value.segments.map((segment) => normalizeContextSegment(segment, ids));
  segments.sort(compareSegments);
  const coverage = normalizeCoverage(value.coverage, segments);

  return {
    sessionId,
    revision,
    state: value.state,
    complete: value.complete,
    reason,
    coverage,
    segments
  };
}

function normalizeContextSegment(value, ids) {
  if (!isRecord(value)) throw new TypeError("Debrief context segment is invalid.");
  const id = normalizeIdentifier(value.id, "source segment ID", 256);
  if (ids.has(id)) throw new TypeError(`Duplicate debrief source segment ID: ${id}`);
  ids.add(id);
  const startMs = normalizeInteger(value.start_ms, "source start", 0);
  const endMs = normalizeInteger(value.end_ms, "source end", startMs);
  if (typeof value.text !== "string"
    || value.text.trim().length === 0
    || value.text.length > 20_000
    || containsUnsafeDebriefTextControl(value.text)
    || hasUnpairedDebriefSurrogate(value.text)) {
    throw new TypeError("Debrief source text must be non-empty, bounded, and free of unsafe controls.");
  }
  if (!new Set(["system", "microphone"]).has(value.track)) {
    throw new TypeError("Debrief source track is invalid.");
  }
  return {
    id,
    start_ms: startMs,
    end_ms: endMs,
    track: value.track,
    text: value.text,
    speaker_id: typeof value.speaker_id === "string" && value.speaker_id.trim()
      ? value.speaker_id.trim()
      : null
  };
}

function normalizeCoverage(value, segments) {
  if (!isRecord(value)) throw new TypeError("Debrief context coverage is required.");
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
  if (typeof normalized.truncated !== "boolean") throw new TypeError("Coverage truncation must be a boolean.");
  if (normalized.includedFinalSegments !== segments.length) {
    throw new TypeError("Coverage included-segment count is inconsistent.");
  }
  if (normalized.totalFinalSegments !== normalized.includedFinalSegments + normalized.omittedFinalSegments) {
    throw new TypeError("Coverage segment counts are inconsistent.");
  }
  if (normalized.truncated !== (normalized.omittedFinalSegments > 0)) {
    throw new TypeError("Coverage truncation state is inconsistent.");
  }
  const includedTranscriptChars = segments.reduce((total, segment) => total + segment.text.length, 0);
  if (normalized.includedTranscriptChars !== includedTranscriptChars) {
    throw new TypeError("Coverage included-character count is inconsistent.");
  }
  if (normalized.totalTranscriptChars < normalized.includedTranscriptChars) {
    throw new TypeError("Coverage total-character count is inconsistent.");
  }
  const expectedStart = segments.length > 0 ? segments[0].start_ms : null;
  const expectedEnd = segments.length > 0
    ? segments.reduce((latest, segment) => Math.max(latest, segment.end_ms), 0)
    : null;
  if (normalized.includedStartMs !== expectedStart || normalized.includedEndMs !== expectedEnd) {
    throw new TypeError("Coverage included time range is inconsistent.");
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
    throw new TypeError("Coverage included range is outside the observed range.");
  }
  return normalized;
}

function assertCoverageRange(segmentCount, transcriptChars, startMs, endMs, label) {
  if (segmentCount === 0) {
    if (transcriptChars !== 0 || startMs !== null || endMs !== null) {
      throw new TypeError(`Coverage ${label} range must be empty for zero segments.`);
    }
    return;
  }
  if (transcriptChars === 0 || startMs === null || endMs === null || endMs < startMs) {
    throw new TypeError(`Coverage ${label} range is inconsistent.`);
  }
}

function freezeCoverageClone(value) {
  return Object.freeze({ ...value });
}

function boundedText(value) {
  return boundDebriefExtractText(value);
}

function normalizeWhitespace(value) {
  return normalizeDebriefText(value);
}

function normalizeIdentifier(value, label, maxLength) {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return normalized;
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

function compareSegments(left, right) {
  return left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.id.localeCompare(right.id);
}

function formatDuration(totalSeconds) {
  if (totalSeconds < 60) return `${totalSeconds} seconds`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes} minutes` : `${minutes}m ${seconds}s`;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
