import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const text = fs.readFileSync(
  path.resolve(import.meta.dirname, "..", "scripts", "RELEASE-CODEBRIDGE.cmd"),
  "utf8",
);

test("release launcher runs only the reviewed release script and never deploys", () => {
  assert.match(text, /"%BASH%" scripts\/release\.sh %\*/);
  assert.doesNotMatch(text, /--yes/);
  assert.doesNotMatch(
    text,
    /curl|Invoke-WebRequest|ssh|scp|systemctl|reset --hard|push --force/i,
  );
});

test("release launcher fails closed on a wrong branch, local changes or non fast-forward", () => {
  for (const code of [
    "GIT_BASH_NOT_FOUND",
    "GH_NOT_FOUND",
    "NOT_ON_MAIN",
    "LOCAL_CHANGES",
    "CANNOT_FAST_FORWARD",
  ])
    assert.ok(text.includes(`KMJ_RELEASE=BLOCKED:${code}`), code);
  assert.match(text, /git pull --ff-only origin main/);
});

test("release launcher keeps the key outside the repository and holds the window open and uses no goto labels", () => {
  assert.doesNotMatch(text, /\.pem|BEGIN [A-Z ]*PRIVATE/);
  assert.match(text, /^pause\r?$/m);
  assert.doesNotMatch(
    text,
    /^\s*goto\b|^:\w+/m,
    "no labels: safe with LF endings",
  );
});
