import assert from "node:assert/strict";
import test from "node:test";
import { assertWindowsCandidateUnchanged } from "../src/windows-signed-feed.js";

const admitted = {
  state: "NEW_SIGNED_RELEASE_CANDIDATE",
  sequence: 44,
  revision: "a".repeat(40),
  runningRevision: "b".repeat(40),
  archiveSha256: "c".repeat(64),
  archiveBytes: 2048,
  manifestSha256: "d".repeat(64),
};

test("unchanged signed candidate remains eligible for staging", () => {
  assert.doesNotThrow(() =>
    assertWindowsCandidateUnchanged(admitted, { ...admitted }),
  );
});

test("staging refuses any change in admitted release identity", () => {
  const changes = [
    { state: "CURRENT_ACCEPTED_REVISION" },
    { sequence: 45 },
    { revision: "e".repeat(40) },
    { runningRevision: "e".repeat(40) },
    { archiveSha256: "e".repeat(64) },
    { archiveBytes: 2049 },
    { manifestSha256: "e".repeat(64) },
  ];
  for (const change of changes) {
    assert.throws(
      () =>
        assertWindowsCandidateUnchanged(admitted, {
          ...admitted,
          ...change,
        }),
      /WINDOWS_UPDATE_CANDIDATE_CHANGED/,
    );
  }
});

test("staging requires an admitted manifest digest", () => {
  const invalid = { ...admitted, manifestSha256: undefined };
  assert.throws(
    () => assertWindowsCandidateUnchanged(invalid, invalid),
    /WINDOWS_UPDATE_CANDIDATE_CHANGED/,
  );
});
