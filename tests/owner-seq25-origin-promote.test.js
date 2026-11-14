import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

const dir = "scripts/production/";
const read = (name) => fs.readFileSync(dir + name, "utf8");
const publish24 = read("owner_publish_seq24_static_origin_20261113.py");
const publish25 = read("owner_publish_seq25_static_origin_20261114.py");
const promote24 = read("owner_promote_signed24_stable_config_20261113.py");
const promote25 = read("owner_promote_signed25_stable_config_20261114.py");

const REV = "55a3f976fd3b71e36b4dcb1864b04d43364418ac";
const PREVIOUS = "dd1ccf3232f9678df6e8e87172c36ff4397c0cac";
const manifestPath = `releases/stable/${REV}/release-manifest.json`;
const manifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes);
const manifestSha = createHash("sha256").update(manifestBytes).digest("hex");

// Normalise only release-specific identifiers so structure is compared.
// nodeMajor (24) is deliberately not a release identifier and must not move.
const normalise = (text) =>
  text
    .replace(/\b[0-9a-f]{64}\b/g, "SHA256")
    .replace(/\b[0-9a-f]{40}\b/g, "FULLSHA")
    .replace(/0\.3\.2-[0-9a-f]{12}/g, "RELARCHIVE")
    .replace(/seq\d+-[0-9a-f]{8}/g, "RELTAG")
    .replace(/SIGNED\d+/g, "SIGNEDN")
    .replace(/signed\d+/g, "signedN")
    .replace(/seq\d+/g, "seqN")
    .replace(/sequence"\) ?== ?\d+/g, "sequence==N")
    .replace(/sequence",-1\)\) < \d+/g, "sequence<N")
    .replace(/ARCHIVE_SIZE = \d+/g, "ARCHIVE_SIZE = N")
    .replace(/ARCHIVE: \("SHA256", \d+\)/g, 'ARCHIVE: ("SHA256", N)');

test("seq25 owner scripts are structurally identical to the reviewed seq24 scripts", () => {
  assert.equal(normalise(publish25), normalise(publish24));
  assert.equal(normalise(promote25), normalise(promote24));
});

test("seq25 scripts pin the committed signed manifest and the previous live release", () => {
  assert.equal(manifest.sequence, 25);
  assert.equal(manifest.revision, REV);
  for (const text of [publish25, promote25]) {
    assert.ok(text.includes(manifestSha), "manifest sha256 pin");
    assert.ok(text.includes(manifest.sha256), "archive sha256 pin");
    assert.ok(text.includes(String(manifest.bytes)), "archive size pin");
    assert.ok(text.includes(PREVIOUS), "previous release pin");
    assert.doesNotMatch(text, /37a6627b|cca7259d|signed24|SIGNED24|seq24/);
  }
  assert.match(publish25, new RegExp(`REV = "${REV}"`));
  assert.match(publish25, new RegExp(`PREVIOUS = "${PREVIOUS}"`));
  assert.match(publish25, /info\.get\("sequence"\) == 25/);
  assert.match(publish25, /codebridge-stable-seq25-55a3f976\//);
  assert.match(promote25, new RegExp(`OLD = "${PREVIOUS}"`));
  assert.match(promote25, new RegExp(`NEW = "${REV}"`));
  assert.match(promote25, /item\.get\("sequence"\)==25/);
  assert.match(promote25, /item\.get\("nodeMajor"\)==24/);
  assert.match(promote25, /stable-update\.before-signed25\.json/);
});

test("seq25 publish script reads metadata from a commit that contains it", () => {
  const source = /SOURCE = "([0-9a-f]{40})"/.exec(publish25)?.[1];
  assert.equal(source, "4ec317ffc5c03562749c527136830e00404a30f9");
});
