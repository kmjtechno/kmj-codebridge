import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { exactApprovedSource } from "../scripts/production/owner-auto-sign-stable-v2.mjs";
import {
  parseReleaseArgs,
  signerFailureCode,
} from "../scripts/production/elite-onehost-release-v2.mjs";

const sha = "a".repeat(40);

test("the V2 signer admits only the exact approved fetched and remote SHA", () => {
  assert.equal(exactApprovedSource(sha, sha, sha), true);
  for (const [expected, fetched, remote] of [
    [sha, "b".repeat(40), sha],
    [sha, sha, "b".repeat(40)],
    [undefined, sha, sha],
    [sha + "\n", sha + "\n", sha + "\n"],
    ["main", "main", "main"],
  ]) {
    assert.equal(exactApprovedSource(expected, fetched, remote), false);
  }
});

test("signing and preflight require an exact SHA; inspect is nonmutating", () => {
  assert.deepEqual(parseReleaseArgs(["--inspect"]), {
    mode: "--inspect",
    sha: null,
  });
  assert.deepEqual(parseReleaseArgs(["--sign-once", sha]), {
    mode: "--sign-once",
    sha,
  });
  assert.deepEqual(parseReleaseArgs(["--preflight", sha]), {
    mode: "--preflight",
    sha,
  });
  for (const args of [
    ["--sign-once"],
    ["--preflight", "main"],
    ["--inspect", sha],
    ["--sign-once", sha + "\n"],
    ["--sign-once", sha, "--admin"],
  ]) {
    assert.throws(() => parseReleaseArgs(args), /ARGUMENT_NOT_ALLOWED/);
  }
});

test("only one known blocker code may leave the pinned signer", () => {
  assert.equal(
    signerFailureCode(
      "AUTO_SIGNED_RELEASE=BLOCKED:SEQUENCE_POLICY_EXHAUSTED\n",
    ),
    "SEQUENCE_POLICY_EXHAUSTED",
  );
  for (const output of [
    "AUTO_SIGNED_RELEASE=BLOCKED:SECRET_VALUE\n",
    "AUTO_SIGNED_RELEASE=BLOCKED:SEQUENCE_POLICY_EXHAUSTED\nAUTO_SIGNED_RELEASE=BLOCKED:APPROVED_SOURCE_MOVED\n",
    "arbitrary diagnostic\n",
  ]) {
    assert.equal(
      signerFailureCode(output),
      "OWNER_SIGNING_FAILED_REVIEW_REQUIRED",
    );
  }
});

test("new operator pins the V2 signer and keeps legacy operator unchanged", () => {
  const signer = fs.readFileSync(
    "scripts/production/owner-auto-sign-stable-v2.mjs",
  );
  const wrapper = fs.readFileSync(
    "scripts/production/elite-onehost-release-v2.mjs",
    "utf8",
  );
  assert.ok(
    wrapper.includes(createHash("sha256").update(signer).digest("hex")),
  );
  assert.match(signer.toString(), /if \(preflight\) \{/);
  assert.match(signer.toString(), /OWNER_POLICY_CHANGED_BEFORE_KEY/);
  assert.ok(
    signer.toString().indexOf("if (preflight)") <
      signer.toString().indexOf("const key = privateFile(p.keyFile"),
  );
});
