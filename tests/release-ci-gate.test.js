import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import {
  assessReleaseChecks,
  REQUIRED_RELEASE_CHECKS,
} from "../scripts/release-ci-gate.mjs";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const ciCheck = (name, options = {}) => ({
  name,
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  app: { slug: "github-actions" },
  ...options,
});
function good(extra = []) {
  const check_runs = [
    ...REQUIRED_RELEASE_CHECKS.map((name) => ciCheck(name)),
    ...extra,
  ];
  return { total_count: check_runs.length, check_runs };
}

test("exact head CI success is necessary and only a signing preflight", () => {
  const result = assessReleaseChecks(good(), SHA);
  assert.deepEqual(result, {
    ready: true,
    reason: "PASS",
    checks: 5,
    revision: SHA,
  });
  assert.equal(
    assessReleaseChecks(good([ciCheck("extra-security")]), SHA).ready,
    true,
  );
});

test("missing and red mandatory checks block owner signing", () => {
  for (const result of [
    { total_count: 4, check_runs: good().check_runs.slice(0, 4) },
    good([ciCheck("extra-security", { conclusion: "failure" })]),
    good([ciCheck("extra-security", { status: "queued", conclusion: null })]),
    good([ciCheck("extra-security", { conclusion: "neutral" })]),
    good([ciCheck("extra-security", { conclusion: "skipped" })]),
    good([ciCheck("registry_manifest", { conclusion: "failure" })]),
  ]) {
    assert.equal(assessReleaseChecks(result, SHA).ready, false);
  }
});

test("duplicate fully-green GitHub Actions checks for the same SHA are admitted", () => {
  const double = good(REQUIRED_RELEASE_CHECKS.map((name) => ciCheck(name)));
  assert.deepEqual(assessReleaseChecks(double, SHA), {
    ready: true,
    reason: "PASS",
    checks: 10,
    revision: SHA,
  });
  // All duplicates are still verified; no failed, queued, forged or stale
  // duplicate may be masked by a successful run with the same name.
  for (const bad of [
    ciCheck("clients", { conclusion: "failure" }),
    ciCheck("clients", { status: "in_progress", conclusion: null }),
    ciCheck("clients", { app: { slug: "untrusted" } }),
    ciCheck("clients", { head_sha: OTHER }),
  ]) {
    assert.equal(assessReleaseChecks(good([bad]), SHA).ready, false);
  }
});

test("wrong commit, forged app identity and truncation block signing", () => {
  for (const result of [
    good([ciCheck("extra-security", { head_sha: OTHER })]),
    good([ciCheck("extra-security", { app: { slug: "other-check-app" } })]),
    good([ciCheck("extra-security", { app: null })]),
    { ...good(), total_count: 101 },
    { ...good(), total_count: 6 },
    { ...good(), total_count: 4 },
    { ...good(), check_runs: [null, ...good().check_runs.slice(1)] },
    { total_count: 5, check_runs: [] },
    null,
    {},
  ]) {
    assert.equal(assessReleaseChecks(result, SHA).ready, false);
  }
  assert.equal(assessReleaseChecks(good(), "short").ready, false);
});

test("signed_release check never replaces mandatory CI evidence", () => {
  const withSigned = good([
    ciCheck("signed_release", { conclusion: "failure" }),
  ]);
  assert.equal(assessReleaseChecks(withSigned, SHA).ready, true);
  const subset = { total_count: 5, check_runs: withSigned.check_runs.slice(1) };
  assert.equal(assessReleaseChecks(subset, SHA).ready, false);
});

test("CLI accepts only bounded verified GitHub JSON and never prints it", () => {
  const invoke = (data) =>
    spawnSync("node", ["scripts/release-ci-gate.mjs", SHA], {
      input: data,
      encoding: "utf8",
    });
  const pass = invoke(JSON.stringify(good()));
  assert.equal(pass.status, 0, pass.stderr);
  assert.match(pass.stdout, /^RELEASE_EXACT_HEAD_CI=PASS/m);
  assert.doesNotMatch(pass.stdout, /check_runs|github-actions/);
  const tooLong = invoke("x".repeat(1024 * 1024 + 10));
  assert.equal(tooLong.status, 2);
  assert.match(tooLong.stdout, /BLOCKED:CI_RESULT_OVERSIZED/);
  const malformed = invoke("{broken");
  assert.equal(malformed.status, 2);
  assert.match(malformed.stdout, /BLOCKED:CI_VERIFICATION_FAILED/);
  const missing = invoke("");
  assert.equal(missing.status, 2);
});

test("owner release shell never signs without exact GitHub checks or deletes unowned branches", () => {
  const source = fs.readFileSync("scripts/release.sh", "utf8");
  assert.match(source, /gh auth status.*GH_AUTH_REQUIRED/s);
  assert.match(source, /node scripts\/release-ci-gate\.mjs "\$SOURCE"/);
  assert.match(source, /CI_NOT_INDEPENDENTLY_VERIFIED/);
  assert.match(source, /CODEBRIDGE_REMOTE_NOT_TRUSTED/);
  assert.match(source, /SIGNED_HISTORY_NOT_FOUND/);
  assert.match(source, /git ls-tree -r --name-only origin\/main/);
  assert.match(source, /CREATED_RELEASE_BRANCH=no/);
  assert.match(source, /CREATED_RELEASE_BRANCH=yes/);
  assert.match(source, /if \[\[ "\$CREATED_RELEASE_BRANCH" == yes \]\]/);
  assert.doesNotMatch(source, /gh CLI not logged in.*skipped|HAVE_GH/);
  assert.doesNotMatch(
    source,
    /curl.*\|\s*(?:sudo\s+)?bash|git reset|git clean/,
  );
});

test("owner release bash syntax passes when bash is installed", (t) => {
  const shell = spawnSync("bash", ["-n", "scripts/release.sh"], {
    encoding: "utf8",
  });
  if (shell.error?.code === "ENOENT") {
    t.skip("bash unavailable on this runner");
    return;
  }
  assert.equal(shell.status, 0, shell.stderr);
});
