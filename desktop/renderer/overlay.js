const bridge = window.overlay;
const INITIAL_STATUS_RETRY_DELAYS_MS = Object.freeze([0, 200, 600]);

const elements = {
  captureStrip: document.querySelector(".capture-strip"),
  meetingState: document.querySelector("#meeting-state-label"),
  sourceSummary: document.querySelector("#source-summary"),
  meetingIssue: document.querySelector("#meeting-issue"),
  elapsed: document.querySelector("#elapsed"),
  segments: document.querySelector("#segments"),
  suggestion: document.querySelector("#suggestion"),
  providerState: document.querySelector("#provider-state"),
  providerDisclosure: document.querySelector("#provider-disclosure"),
  visibilityLabel: document.querySelector("#visibility-label"),
  openWorkspace: document.querySelector("#open-workspace"),
  focusCopilot: document.querySelector("#focus-copilot"),
  hideOverlay: document.querySelector("#hide-overlay")
};

let renderedSegmentsSignature = null;
let renderedSuggestionSignature = null;

elements.openWorkspace.addEventListener("click", () => void bridge.showWorkspace());
elements.focusCopilot.addEventListener("click", () => void bridge.focusCopilot());
elements.hideOverlay.addEventListener("click", () => void bridge.hide());

bridge.onStatus(renderStatus);
void loadInitialStatus().catch(() => false);

async function loadInitialStatus() {
  for (const delayMs of INITIAL_STATUS_RETRY_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs);
    try {
      const result = await bridge.getStatus();
      if (result?.ok && result.status && renderStatus(result.status)) return true;
    } catch {
      // Main may still be registering IPC during launch. Status events remain available after this bounded retry.
    }
  }
  return false;
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function renderStatus(value) {
  const status = sanitizeStatus(value);
  if (!status) return false;
  elements.captureStrip.dataset.recording = String(status.meeting.recording);
  setTextIfChanged(elements.meetingState, status.meeting.label);
  setTextIfChanged(elements.sourceSummary, status.meeting.sourceSummary);
  renderMeetingIssue(status.meeting.issue);
  elements.elapsed.textContent = formatElapsed(status.meeting.elapsedMs);
  elements.elapsed.dateTime = toDuration(status.meeting.elapsedMs);
  renderSegments(status.meeting.segments);
  renderSuggestion(status.assist);
  setTextIfChanged(elements.providerState, status.provider.label);
  setTextIfChanged(elements.providerDisclosure, status.provider.disclosure);
  setTextIfChanged(elements.visibilityLabel, status.overlay.mode === "private"
    ? `Private mode · ${Math.round(status.overlay.opacity * 100)}% opacity · privacy aid, not invisibility`
    : "Overt companion · fully opaque");
  return true;
}

function renderSegments(segments) {
  const signature = JSON.stringify(segments.map((segment) => [
    segment.id ?? null,
    segment.speaker,
    segment.source,
    segment.text,
    segment.translation ?? null
  ]));
  if (signature === renderedSegmentsSignature) return;
  renderedSegmentsSignature = signature;
  elements.segments.replaceChildren();
  if (segments.length === 0) {
    elements.segments.append(emptyParagraph("Finalized speech will appear here while recording."));
    return;
  }
  for (const segment of segments) {
    const article = document.createElement("article");
    article.className = "segment";
    const metadata = document.createElement("div");
    metadata.className = "segment-meta";
    const speaker = document.createElement("strong");
    speaker.textContent = segment.speaker;
    const source = document.createElement("span");
    source.textContent = segment.source;
    metadata.append(speaker, source);
    const text = document.createElement("p");
    text.textContent = segment.text;
    article.append(metadata, text);
    if (segment.translation) {
      const translation = document.createElement("p");
      translation.className = "translation";
      translation.textContent = segment.translation;
      article.append(translation);
    }
    elements.segments.append(article);
  }
}

function renderSuggestion(assist) {
  const signature = JSON.stringify([
    assist.state,
    assist.suggestion?.text ?? null,
    assist.suggestion?.requestId ?? null,
    assist.suggestion?.contextRevision ?? null,
    assist.suggestion?.stale === true
  ]);
  if (signature === renderedSuggestionSignature) return;
  renderedSuggestionSignature = signature;
  elements.suggestion.replaceChildren();
  elements.suggestion.dataset.state = assist.state;
  if (!assist.suggestion) {
    const message = assist.state === "working"
      ? "Generating the response you requested in the workspace…"
      : assist.state === "error"
        ? "The last assistance request failed. Your local transcript continues normally."
        : "Suggestions you explicitly request in the workspace will appear here.";
    elements.suggestion.append(emptyParagraph(message));
    return;
  }
  if (assist.state === "stale" || assist.suggestion.stale === true) {
    const stale = document.createElement("p");
    stale.className = "suggestion-status";
    stale.textContent = "Previous suggestion — the transcript changed after it was generated.";
    elements.suggestion.append(stale);
  }
  const response = document.createElement("p");
  response.textContent = assist.suggestion.text;
  elements.suggestion.append(response);
}

function renderMeetingIssue(issue) {
  const visible = Boolean(issue && typeof issue.message === "string" && issue.message.trim());
  elements.meetingIssue.hidden = !visible;
  elements.meetingIssue.dataset.level = visible && issue.level === "error" ? "error" : "warning";
  setTextIfChanged(elements.meetingIssue, visible ? issue.message.trim() : "");
}

function setTextIfChanged(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

function emptyParagraph(value) {
  const paragraph = document.createElement("p");
  paragraph.className = "empty-state";
  paragraph.textContent = value;
  return paragraph;
}

function sanitizeStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!value.meeting || !value.assist || !value.provider || !value.overlay) return null;
  if (!Array.isArray(value.meeting.segments)) return null;
  return value;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((entry) => String(entry).padStart(2, "0"))
    .join(":");
}

function toDuration(milliseconds) {
  return `PT${Math.max(0, Math.floor(milliseconds / 1_000))}S`;
}
