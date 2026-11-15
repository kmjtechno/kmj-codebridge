import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";

const dir = "scripts/production/";
const read = (name) => fs.readFileSync(dir + name, "utf8");
const publishPrev = read("owner_publish_seq25_static_origin_20261114.py");
const publishNew = read("owner_publish_seq26_static_origin_20261115.py");
const promotePrev = read("owner_promote_signed25_stable_config_20261114.py");
const promoteNew = read("owner_promote_signed26_stable_config_20261115.py");

const REV = "2e8c4b7ddd2c7471000221c39b4e4bbd7dced8d5";
const PREVIOUS = "55a3f976fd3b71e36b4dcb1864b04d43364418ac";
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

test("seq26 owner scripts are structurally identical to the seq25 scripts that ran live", () => {
  assert.equal(normalise(publishNew), normalise(publishPrev));
  assert.equal(normalise(promoteNew), normalise(promotePrev));
});

test("seq26 scripts pin the committed signed manifest and the previous live release", () => {
  assert.equal(manifest.sequence, 26);
  assert.equal(manifest.revision, REV);
  for (const text of [publishNew, promoteNew]) {
    assert.ok(text.includes(manifestSha), "manifest sha256 pin");
    assert.ok(text.includes(manifest.sha256), "archive sha256 pin");
    assert.ok(text.includes(String(manifest.bytes)), "archive size pin");
    assert.ok(text.includes(PREVIOUS), "previous release pin");
    assert.doesNotMatch(text, /dd1ccf32|4ec317ff|signed25|SIGNED25|seq25/);
  }
  assert.match(publishNew, new RegExp(`REV = "${REV}"`));
  assert.match(publishNew, new RegExp(`PREVIOUS = "${PREVIOUS}"`));
  assert.match(publishNew, /info\.get\("sequence"\) == 26/);
  assert.match(publishNew, /codebridge-stable-seq26-2e8c4b7d\//);
  assert.match(promoteNew, new RegExp(`OLD = "${PREVIOUS}"`));
  assert.match(promoteNew, new RegExp(`NEW = "${REV}"`));
  assert.match(promoteNew, /item\.get\("sequence"\)==26/);
  assert.match(promoteNew, /item\.get\("nodeMajor"\)==24/);
  assert.match(promoteNew, /stable-update\.before-signed26\.json/);
});

test("seq26 publish script reads metadata from a commit that contains it", () => {
  const source = /SOURCE = "([0-9a-f]{40})"/.exec(publishNew)?.[1];
  assert.equal(source, "996628723aa271fd381ca4dc5a2a223f4d01ceee");
});
