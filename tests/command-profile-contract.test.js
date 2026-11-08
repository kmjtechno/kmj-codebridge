import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  COMMAND_PRESET_IDS,
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
