const TRACK_LABELS = Object.freeze({
  system: "Meeting audio",
  microphone: "You"
});

const DEFAULT_TRACK_LABEL = "Audio";
const DEFAULT_SPEAKER_PREFIX = "Speaker";
const MAX_SPEAKER_ALIAS_LENGTH = 64;

export class TranscriptStore {
  constructor() {
    this.segments = new Map();
    this.speakerAliases = new Map();
    this.nextSpeakerNumber = 1;
  }

  clear() {
    this.reset();
  }

  reset() {
    this.segments.clear();
    this.speakerAliases.clear();
    this.nextSpeakerNumber = 1;
  }

  replace(segments) {
    this.reset();
    for (const segment of [...segments].sort(compareSegments)) {
      this.segments.set(segment.id, { ...segment });
      this.#registerSpeaker(segment);
    }
  }

  snapshot() {
    return {
      segments: this.getAll().map((segment) => ({ ...segment })),
      speakerAliases: [...this.speakerAliases].map(([speakerId, alias]) => ({
        speakerId,
        alias
      }))
    };
  }

  restore(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.segments) || !Array.isArray(snapshot.speakerAliases)) {
      throw new TypeError("A transcript snapshot is required.");
    }

    const segments = snapshot.segments.map((segment) => ({ ...segment }));
    const speakerAliases = new Map();
    for (const entry of snapshot.speakerAliases) {
      if (!entry || entry.speakerId === null || entry.speakerId === undefined) {
        throw new TypeError("Snapshot speaker IDs must be non-null.");
      }
      const speakerId = String(entry.speakerId);
      if (speakerAliases.has(speakerId)) {
        throw new TypeError(`Snapshot contains duplicate speaker ID: ${speakerId}`);
      }
      speakerAliases.set(speakerId, normalizeSpeakerAlias(entry.alias));
    }

    this.segments = new Map();
    this.speakerAliases = speakerAliases;
    this.nextSpeakerNumber = speakerAliases.size + 1;
    for (const segment of segments.sort(compareSegments)) {
      this.segments.set(segment.id, segment);
      this.#registerSpeaker(segment);
    }
  }

  reconcile(event) {
    if (!event || !["partial_transcript", "final_segment"].includes(event.type)) return false;
    const incoming = normalizeSegment(event.segment, event.type);
    const current = this.segments.get(incoming.id);

    if (current) {
      if (incoming.revision < current.revision) return false;
      if (current.final && !incoming.final) return false;
      if (incoming.revision === current.revision) {
        if (current.final || !incoming.final) return false;
      }
    }

    this.segments.set(incoming.id, incoming);
    this.#registerSpeaker(incoming);
    return true;
  }

  getAll() {
    return [...this.segments.values()].sort(compareSegments);
  }

  getFinalized() {
    return this.getAll().filter((segment) => segment.final);
  }

  hasFinalized() {
    for (const segment of this.segments.values()) {
      if (segment.final) return true;
    }
    return false;
  }

  getSpeakerLabel(segment) {
    if (segment?.track === "microphone") return TRACK_LABELS.microphone;
    if (segment?.track !== "system" || segment.speaker_id === null || segment.speaker_id === undefined) {
      return getTrackLabel(segment?.track);
    }
    return this.speakerAliases.get(String(segment.speaker_id)) ?? TRACK_LABELS.system;
  }

  getSpeakerAlias(speakerId) {
    if (speakerId === null || speakerId === undefined) return null;
    return this.speakerAliases.get(String(speakerId)) ?? null;
  }

  getSpeakerAliases() {
    return [...this.speakerAliases].map(([speakerId, alias]) => ({ speakerId, alias }));
  }

  renameSpeaker(speakerId, alias) {
    if (speakerId === null || speakerId === undefined) {
      throw new TypeError("A non-null speaker ID is required.");
    }
    const key = String(speakerId);
    if (!this.speakerAliases.has(key)) {
      throw new RangeError(`Unknown speaker ID: ${key}`);
    }
    const normalizedAlias = normalizeSpeakerAlias(alias);
    this.speakerAliases.set(key, normalizedAlias);
    return normalizedAlias;
  }

  toMarkdown({ title = "Meeting transcript" } = {}) {
    const lines = [`# ${title}`, ""];
    const finalized = this.getFinalized();
    if (finalized.length === 0) {
      lines.push("_No finalized segments._", "");
      return lines.join("\n");
    }

    for (const segment of finalized) {
      const timestamp = formatTimestamp(segment.start_ms);
      const label = this.getSpeakerLabel(segment);
      lines.push(
        `**[${timestamp}] ${escapeMarkdown(label)}:** ${escapeMarkdown(segment.text)}`,
        ""
      );
      if (segment.translated_text !== null) {
        lines.push(
          `> **Brazilian Portuguese:** ${escapeMarkdown(segment.translated_text)}`,
          ""
        );
      }
    }
    return lines.join("\n");
  }

  #registerSpeaker(segment) {
    if (segment?.track !== "system" || segment.speaker_id === null || segment.speaker_id === undefined) {
      return;
    }
    const speakerId = String(segment.speaker_id);
    if (this.speakerAliases.has(speakerId)) return;
    this.speakerAliases.set(speakerId, `${DEFAULT_SPEAKER_PREFIX} ${this.nextSpeakerNumber}`);
    this.nextSpeakerNumber += 1;
  }
}

export function getTrackLabel(track) {
  return TRACK_LABELS[track] ?? DEFAULT_TRACK_LABEL;
}

export function formatTimestamp(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
  }
  return [minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}

function normalizeSegment(segment, eventType) {
  if (!segment || typeof segment !== "object") throw new TypeError("Segment is required.");
  const final = eventType === "final_segment";
  const translatedText = segment.translated_text ?? null;
  const translatedLanguage = segment.translated_language ?? null;
  if (translatedText !== null) {
    if (!final || typeof translatedText !== "string" || translatedText.length > 20_000) {
      throw new TypeError("Translated text must be bounded and final.");
    }
    if (translatedLanguage !== "pt-BR") throw new TypeError("Translated language must be pt-BR.");
  } else if (translatedLanguage !== null) {
    throw new TypeError("Translated language requires translated text.");
  }
  return {
    id: String(segment.id),
    revision: Number(segment.revision),
    start_ms: Number(segment.start_ms),
    end_ms: Number(segment.end_ms),
    track: segment.track,
    text: String(segment.text ?? ""),
    partial: !final,
    final,
    language: segment.language ?? null,
    speaker_id: segment.speaker_id ?? null,
    translated_text: translatedText,
    translated_language: translatedLanguage
  };
}

function compareSegments(left, right) {
  return left.start_ms - right.start_ms
    || left.end_ms - right.end_ms
    || left.id.localeCompare(right.id);
}

function escapeMarkdown(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "\\$1");
}

function normalizeSpeakerAlias(alias) {
  if (typeof alias !== "string") throw new TypeError("Speaker alias must be a string.");
  const normalizedAlias = alias.trim();
  if (normalizedAlias.length === 0) throw new RangeError("Speaker alias cannot be empty.");
  if (normalizedAlias.length > MAX_SPEAKER_ALIAS_LENGTH) {
    throw new RangeError(`Speaker alias cannot exceed ${MAX_SPEAKER_ALIAS_LENGTH} characters.`);
  }
  return normalizedAlias;
}
