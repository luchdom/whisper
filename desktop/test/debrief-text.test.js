import assert from "node:assert/strict";
import test from "node:test";
import {
  DEBRIEF_MAX_ITEM_TEXT_CHARS,
  boundDebriefExtractText,
  isDebriefExtractDerivedFromOriginal,
  normalizeDebriefText
} from "../shared/debrief-text.js";

test("local extract verification compares normalized original whitespace", () => {
  const original = "We   decided\n\tto keep every debrief on this device.";
  const extract = normalizeDebriefText(original);

  assert.equal(
    isDebriefExtractDerivedFromOriginal(extract, original),
    true
  );
  assert.equal(
    isDebriefExtractDerivedFromOriginal("We decided to upload the debrief.", original),
    false
  );
});

test("bounded long extracts retain a verifiable normalized original prefix", () => {
  const original = `We decided to keep the meeting local. ${"Evidence ".repeat(260)}Done.`;
  const extract = boundDebriefExtractText(original);

  assert.equal(extract.length <= DEBRIEF_MAX_ITEM_TEXT_CHARS, true);
  assert.equal(extract.endsWith("…"), true);
  assert.equal(isDebriefExtractDerivedFromOriginal(extract, original), true);
});

test("short or source-complete ellipses cannot impersonate bounded extracts", () => {
  assert.equal(
    isDebriefExtractDerivedFromOriginal("We decided to wait…", "We decided to wait…"),
    true
  );
  assert.equal(
    isDebriefExtractDerivedFromOriginal("A short claim…", "A short claim followed by source text."),
    false
  );
  const prefix = "A".repeat(DEBRIEF_MAX_ITEM_TEXT_CHARS - 1);
  assert.equal(isDebriefExtractDerivedFromOriginal(`${prefix}…`, prefix), false);
});
