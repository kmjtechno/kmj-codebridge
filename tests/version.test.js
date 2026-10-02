import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { VERSION } from "../src/version.js";

test("runtime version matches package metadata", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(VERSION, packageJson.version);
});
