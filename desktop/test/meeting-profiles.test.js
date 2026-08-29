import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MEETING_PROFILE_ID,
  MEETING_PROFILE_IDS,
  MEETING_PROFILE_SCHEMA_VERSION,
  MeetingProfileError,
  getMeetingProfile,
  getMeetingProfileCatalogDto,
  normalizeMeetingProfileSelection
} from "../main/meeting-profiles.js";

const EXPECTED_IDS = Object.freeze([
  "general",
  "sales",
  "interview",
  "presentation",
  "leadership_negotiation",
  "custom"
]);

const ALL_CONTEXT_KINDS = new Set([
  "objective",
  "talking_points",
  "job_description",
  "resume",
  "product_facts",
  "presentation_notes",
  "custom_notes"
]);

test("public catalog exposes exactly six ordered, versioned built-in profiles", () => {
  const catalog = getMeetingProfileCatalogDto();

  assert.equal(MEETING_PROFILE_SCHEMA_VERSION, 1);
  assert.equal(DEFAULT_MEETING_PROFILE_ID, "general");
  assert.deepEqual(MEETING_PROFILE_IDS, EXPECTED_IDS);
  assert.deepEqual(Object.keys(catalog), ["schemaVersion", "defaultProfileId", "profiles"]);
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.defaultProfileId, "general");
  assert.deepEqual(catalog.profiles.map(({ id }) => id), EXPECTED_IDS);
  assert.equal(catalog.profiles.length, 6);

  for (const profile of catalog.profiles) {
    assert.deepEqual(Object.keys(profile), [
      "id",
      "version",
      "name",
      "description",
      "responseStyle",
      "allowedContextKinds",
      "quickActions",
      "limitations"
    ]);
    assert.equal(profile.version, 1);
    assert.match(profile.name, /\S/u);
    assert.match(profile.description, /\S/u);
    assert.match(profile.responseStyle, /\S/u);
    assert.equal(profile.responseStyle.length <= 160, true);
    assert.equal(profile.allowedContextKinds.length > 0, true);
    assert.equal(new Set(profile.allowedContextKinds).size, profile.allowedContextKinds.length);
    assert.equal(profile.allowedContextKinds.every((kind) => ALL_CONTEXT_KINDS.has(kind)), true);
    assert.equal(profile.quickActions.length, 3);
    assert.equal(new Set(profile.quickActions.map(({ id }) => id)).size, 3);
    assert.equal(profile.limitations.length, 2);
    for (const action of profile.quickActions) {
      assert.deepEqual(Object.keys(action), ["id", "label", "prompt"]);
      assert.match(action.id, /^[a-z][a-z0-9_]*$/u);
      assert.match(action.label, /\S/u);
      assert.match(action.prompt, /\S/u);
    }
  }
});

test("public catalog is deeply immutable and strips internal policy fields", () => {
  const catalog = getMeetingProfileCatalogDto();

  assertDeeplyFrozen(catalog);
  assert.equal(getMeetingProfileCatalogDto(), catalog, "the canonical immutable DTO is reused");
  assert.throws(() => { catalog.defaultProfileId = "sales"; }, TypeError);
  assert.throws(() => { catalog.profiles[0].quickActions.push({}); }, TypeError);

  const serialized = JSON.stringify(catalog);
  assert.equal(catalog.profiles.some((profile) => Object.hasOwn(profile, "instruction")), false);
  for (const privateValue of ["meeting-profile-policy-v1", "systemPrompt"]) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
});

test("version-pinned lookup returns immutable internal policy without silent fallback", () => {
  for (const id of EXPECTED_IDS) {
    const profile = getMeetingProfile(id, 1);
    assert.equal(profile.id, id);
    assert.equal(profile.version, 1);
    assert.match(profile.instruction, /^meeting-profile-policy-v1:/u);
    assertDeeplyFrozen(profile);
  }

  assert.throws(
    () => getMeetingProfile("removed_profile", 1),
    (error) => error instanceof MeetingProfileError && error.code === "meeting_profile_not_found"
  );
  assert.throws(
    () => getMeetingProfile("general", 2),
    (error) => error instanceof MeetingProfileError && error.code === "meeting_profile_version_mismatch"
  );
  assert.throws(
    () => getMeetingProfile("../general", 1),
    (error) => error instanceof MeetingProfileError && error.code === "invalid_meeting_profile"
  );
});

test("profile selection accepts only the exact closed id and version contract", () => {
  assert.deepEqual(
    normalizeMeetingProfileSelection({ profileId: "sales", profileVersion: 1 }),
    { profileId: "sales", profileVersion: 1 }
  );
  assert.equal(
    Object.isFrozen(normalizeMeetingProfileSelection({ profileId: "sales", profileVersion: 1 })),
    true
  );

  for (const invalid of [
    null,
    [],
    {},
    { profileId: "sales" },
    { profileId: "sales", profileVersion: 1, context: "untrusted" },
    { profileId: "sales", profileVersion: "1" },
    { profileId: "unknown", profileVersion: 1 }
  ]) {
    assert.throws(() => normalizeMeetingProfileSelection(invalid), MeetingProfileError);
  }
});

test("profile-specific context allowlists keep sensitive categories opt-in", () => {
  const catalog = getMeetingProfileCatalogDto();
  const byId = new Map(catalog.profiles.map((profile) => [profile.id, profile]));

  assert.deepEqual(byId.get("sales").allowedContextKinds, [
    "objective", "talking_points", "product_facts", "custom_notes"
  ]);
  assert.deepEqual(byId.get("interview").allowedContextKinds, [
    "objective", "job_description", "resume", "custom_notes"
  ]);
  assert.equal(byId.get("sales").allowedContextKinds.includes("resume"), false);
  assert.equal(byId.get("interview").allowedContextKinds.includes("product_facts"), false);
  assert.deepEqual(new Set(byId.get("custom").allowedContextKinds), ALL_CONTEXT_KINDS);
});

function assertDeeplyFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.equal(Object.isFrozen(value), true);
  for (const child of Object.values(value)) assertDeeplyFrozen(child);
}
