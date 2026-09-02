import assert from "node:assert/strict";
import test from "node:test";
import { TranscriptStore } from "../renderer/lib/transcript-store.js";

function transcriptEvent(type, overrides = {}) {
  const final = type === "final_segment";
  return {
    type,
    segment: {
      id: "segment-1",
      revision: 1,
      start_ms: 2_000,
      end_ms: 3_000,
      track: "system",
      text: "Trecho provisório",
      partial: !final,
      final,
      language: "pt",
      speaker_id: null,
      translated_text: null,
      translated_language: null,
      ...overrides
    }
  };
}

function translationEvent(overrides = {}) {
  return {
    type: "segment_translation",
    segment_id: "segment-1",
    segment_revision: 1,
    translated_text: "Trecho traduzido",
    translated_language: "pt-BR",
    ...overrides
  };
}

test("a final revision replaces its partial in place and cannot be downgraded", () => {
  const store = new TranscriptStore();
  assert.equal(store.reconcile(transcriptEvent("partial_transcript")), true);
  assert.equal(store.reconcile(transcriptEvent("final_segment", { revision: 2, text: "Trecho final" })), true);
  assert.equal(store.reconcile(transcriptEvent("partial_transcript", { revision: 3, text: "Atrasado" })), false);

  assert.equal(store.getAll().length, 1);
  assert.deepEqual(store.getAll()[0], {
    id: "segment-1",
    revision: 2,
    start_ms: 2_000,
    end_ms: 3_000,
    track: "system",
    text: "Trecho final",
    partial: false,
    final: true,
    language: "pt",
    speaker_id: null,
    translated_text: null,
    translated_language: null
  });
});

test("duplicate and stale final events do not create duplicate transcript lines", () => {
  const store = new TranscriptStore();
  const final = transcriptEvent("final_segment", { revision: 4, text: "Confirmado" });
  assert.equal(store.reconcile(final), true);
  assert.equal(store.reconcile(final), false);
  assert.equal(store.reconcile(transcriptEvent("final_segment", { revision: 3 })), false);
  assert.equal(store.getFinalized().length, 1);
});

test("segments sort chronologically and markdown exports finalized text only", () => {
  const store = new TranscriptStore();
  store.reconcile(transcriptEvent("partial_transcript", {
    id: "partial",
    revision: 1,
    start_ms: 3_500,
    end_ms: 4_000,
    text: "Ainda mudando"
  }));
  store.reconcile(transcriptEvent("final_segment", {
    id: "later",
    revision: 1,
    start_ms: 62_000,
    end_ms: 63_000,
    text: "  Segunda   fala  "
  }));
  store.reconcile(transcriptEvent("final_segment", {
    id: "earlier",
    revision: 1,
    start_ms: 1_000,
    end_ms: 2_000,
    track: "microphone",
    text: "Primeira fala"
  }));

  assert.deepEqual(store.getAll().map(({ id }) => id), ["earlier", "partial", "later"]);
  assert.equal(store.toMarkdown(), [
    "# Meeting transcript",
    "",
    "**[00:01] You:** Primeira fala",
    "",
    "**[01:02] Meeting audio:** Segunda fala",
    ""
  ].join("\n"));
});

test("system speakers receive stable first-seen aliases while microphone and null speakers stay fixed", () => {
  const store = new TranscriptStore();
  store.reconcile(transcriptEvent("partial_transcript", { speaker_id: "speaker-b" }));
  store.reconcile(transcriptEvent("final_segment", {
    id: "microphone",
    track: "microphone",
    speaker_id: "ignored-microphone-speaker"
  }));
  store.reconcile(transcriptEvent("final_segment", {
    id: "meeting-audio",
    start_ms: 4_000,
    end_ms: 5_000,
    speaker_id: null
  }));
  store.reconcile(transcriptEvent("final_segment", {
    id: "speaker-a",
    start_ms: 5_000,
    end_ms: 6_000,
    speaker_id: "speaker-a"
  }));

  const byId = new Map(store.getAll().map((segment) => [segment.id, segment]));
  assert.equal(store.getSpeakerLabel(byId.get("segment-1")), "Speaker 1");
  assert.equal(store.getSpeakerLabel(byId.get("microphone")), "You");
  assert.equal(store.getSpeakerLabel(byId.get("meeting-audio")), "Meeting audio");
  assert.equal(store.getSpeakerLabel(byId.get("speaker-a")), "Speaker 2");
  assert.deepEqual(store.getSpeakerAliases(), [
    { speakerId: "speaker-b", alias: "Speaker 1" },
    { speakerId: "speaker-a", alias: "Speaker 2" }
  ]);
});

test("renaming a speaker validates the alias and affects existing, future, and exported segments", () => {
  const store = new TranscriptStore();
  store.reconcile(transcriptEvent("final_segment", { speaker_id: "speaker-a", text: "First" }));

  assert.equal(store.renameSpeaker("speaker-a", "  Alice  "), "Alice");
  assert.equal(store.getSpeakerLabel(store.getAll()[0]), "Alice");

  store.reconcile(transcriptEvent("final_segment", {
    id: "segment-2",
    start_ms: 4_000,
    end_ms: 5_000,
    speaker_id: "speaker-a",
    text: "Second"
  }));
  assert.equal(store.getSpeakerLabel(store.getAll()[1]), "Alice");
  assert.match(store.toMarkdown(), /\*\*\[00:02\] Alice:\*\* First/);
  assert.match(store.toMarkdown(), /\*\*\[00:04\] Alice:\*\* Second/);

  assert.throws(() => store.renameSpeaker("speaker-a", "   "), /cannot be empty/);
  assert.throws(() => store.renameSpeaker("speaker-a", "x".repeat(65)), /cannot exceed 64/);
  assert.throws(() => store.renameSpeaker("missing", "Bob"), /Unknown speaker ID/);
  assert.equal(store.getSpeakerAlias("speaker-a"), "Alice");
});

test("bilingual finals reconcile atomically and export original first with Markdown escaping", () => {
  const store = new TranscriptStore();
  store.reconcile(transcriptEvent("partial_transcript", {
    speaker_id: "speaker-a",
    language: "en",
    text: "Draft *only*"
  }));
  store.reconcile(transcriptEvent("final_segment", {
    revision: 2,
    speaker_id: "speaker-a",
    language: "en",
    text: "Original *text* [link] <tag>",
    translated_text: "Tradução *local* [segura] <tag>",
    translated_language: "pt-BR"
  }));
  store.renameSpeaker("speaker-a", "Alex *Lead*");

  const segment = store.getAll()[0];
  assert.equal(segment.text, "Original *text* [link] <tag>");
  assert.equal(segment.translated_text, "Tradução *local* [segura] <tag>");
  assert.equal(segment.translated_language, "pt-BR");
  assert.equal(store.toMarkdown(), [
    "# Meeting transcript",
    "",
    "**[00:02] Alex \\*Lead\\*:** Original \\*text\\* \\[link\\] \\<tag\\>",
    "",
    "> **Brazilian Portuguese:** Tradução \\*local\\* \\[segura\\] \\<tag\\>",
    ""
  ].join("\n"));

  const restored = new TranscriptStore();
  restored.restore(store.snapshot());
  assert.equal(restored.getAll()[0].translated_text, "Tradução *local* [segura] <tag>");
  assert.equal(restored.getSpeakerAlias("speaker-a"), "Alex *Lead*");
});

test("an asynchronous translation updates only its exact finalized revision", () => {
  const store = new TranscriptStore();
  assert.equal(store.reconcile(translationEvent()), false, "orphan translations are ignored");
  store.reconcile(transcriptEvent("partial_transcript"));
  assert.equal(store.reconcile(translationEvent()), false, "drafts cannot receive translations");
  store.reconcile(transcriptEvent("final_segment", {
    revision: 2,
    language: "en",
    text: "Final phrase"
  }));

  assert.equal(store.reconcile(translationEvent({ segment_revision: 1 })), false, "stale translations are ignored");
  assert.equal(store.reconcile(translationEvent({ segment_revision: 3 })), false, "future translations are ignored");
  assert.equal(store.reconcile(translationEvent({
    segment_revision: 2,
    translated_text: "Frase final"
  })), true);
  assert.equal(store.reconcile(translationEvent({
    segment_revision: 2,
    translated_text: "Duplicada"
  })), false, "duplicate translations are ignored");

  const segment = store.getAll()[0];
  assert.equal(segment.text, "Final phrase");
  assert.equal(segment.revision, 2);
  assert.equal(segment.translated_text, "Frase final");
  assert.match(store.toMarkdown(), /> \*\*Brazilian Portuguese:\*\* Frase final/);
});

test("embedded final translations remain compatible and reject a later duplicate update", () => {
  const store = new TranscriptStore();
  store.reconcile(transcriptEvent("final_segment", {
    translated_text: "Tradução incorporada",
    translated_language: "pt-BR"
  }));
  assert.equal(store.reconcile(translationEvent()), false);
  assert.equal(store.getAll()[0].translated_text, "Tradução incorporada");
});

test("translation invariants reject orphan language, wrong target, oversized text, and translated drafts", () => {
  const store = new TranscriptStore();
  assert.throws(() => store.reconcile(transcriptEvent("final_segment", {
    translated_language: "pt-BR"
  })), /requires translated text/);
  assert.throws(() => store.reconcile(transcriptEvent("final_segment", {
    translated_text: "Texto",
    translated_language: "pt"
  })), /must be pt-BR/);
  assert.throws(() => store.reconcile(transcriptEvent("final_segment", {
    translated_text: "x".repeat(20_001),
    translated_language: "pt-BR"
  })), /bounded and final/);
  assert.throws(() => store.reconcile(transcriptEvent("partial_transcript", {
    translated_text: "Texto",
    translated_language: "pt-BR"
  })), /bounded and final/);
  assert.throws(() => store.reconcile(translationEvent({ translated_text: "" })), /non-empty and bounded/);
  assert.throws(() => store.reconcile(translationEvent({ segment_revision: -1 })), /non-negative integer/);
  assert.throws(() => store.reconcile(translationEvent({ translated_language: "pt" })), /must be pt-BR/);
});

test("snapshot and restore preserve isolated segments and renamed aliases across a failed retry", () => {
  const store = new TranscriptStore();
  store.reconcile(transcriptEvent("final_segment", {
    revision: 2,
    speaker_id: "speaker-a",
    text: "Previous meeting"
  }));
  store.renameSpeaker("speaker-a", "Alice");
  const snapshot = store.snapshot();

  snapshot.segments[0].text = "Changed outside the store";
  snapshot.speakerAliases[0].alias = "Changed outside the store";
  assert.equal(store.getAll()[0].text, "Previous meeting");
  assert.equal(store.getSpeakerAlias("speaker-a"), "Alice");

  const retrySnapshot = store.snapshot();
  store.reset();
  store.reconcile(transcriptEvent("partial_transcript", {
    id: "new",
    speaker_id: "speaker-b",
    text: "New attempt"
  }));
  store.restore(retrySnapshot);

  assert.deepEqual(store.getAll().map(({ id, text }) => ({ id, text })), [
    { id: "segment-1", text: "Previous meeting" }
  ]);
  assert.equal(store.getSpeakerAlias("speaker-a"), "Alice");
  assert.match(store.toMarkdown(), /Alice:\*\* Previous meeting/);
});

test("reset clears session-local aliases and restarts anonymous numbering", () => {
  const store = new TranscriptStore();
  store.reconcile(transcriptEvent("final_segment", { speaker_id: "speaker-a" }));
  store.renameSpeaker("speaker-a", "Alice");

  store.reset();
  assert.deepEqual(store.getAll(), []);
  assert.deepEqual(store.getSpeakerAliases(), []);

  store.reconcile(transcriptEvent("final_segment", { speaker_id: "speaker-z" }));
  assert.equal(store.getSpeakerAlias("speaker-z"), "Speaker 1");
});
