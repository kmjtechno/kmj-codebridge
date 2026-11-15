import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMMAND_PRESET_IDS,
  COMMAND_PROFILE_SCHEMA_VERSION,
  expandCommandPresets,
} from "../src/command-presets.js";

const doc = readFileSync(
  new URL("../docs/COMMAND-PROFILE-SCHEMA.md", import.meta.url),
  "utf8",
);

test("schema doc lists every preset and profile id in the code", () => {
  for (const id of COMMAND_PRESET_IDS) {
    assert.ok(doc.includes(`\`${id}\``), `doc missing preset ${id}`);
    for (const profile of Object.keys(expandCommandPresets([id]))) {
      assert.ok(
        doc.includes(`\`${profile}\``),
        `doc missing profile ${profile}`,
      );
    }
  }
});

test("unknown preset fails closed", () => {
  assert.throws(() => expandCommandPresets(["nope"]), /UNKNOWN_COMMAND_PRESET/);
});

test("schema version constant matches the document version", () => {
  assert.match(COMMAND_PROFILE_SCHEMA_VERSION, /^\d+\.\d+$/);
  assert.ok(
    doc.includes(`Document version: **${COMMAND_PROFILE_SCHEMA_VERSION}**`),
    "doc version differs from COMMAND_PROFILE_SCHEMA_VERSION",
  );
});

test("schema doc states the verified output bound and the missing memory limit", () => {
  assert.ok(doc.includes("32768"));
  assert.ok(doc.includes("no** per-job memory or CPU limit"));
});
