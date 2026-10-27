import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyGitError,
  diagnoseNonrootGit,
} from "../scripts/production/diagnose-development-nonroot-git.mjs";

const worker = { uid: 995, username: "kmjdevci" };
const revision = "a".repeat(40);
const success = (_file, args) =>
  args.includes("cat-file") ? "commit\n" : `${revision}\n`;

test("diagnostic denies root, unknown identity and caller-selected account", () => {
  for (const identity of [
    { uid: 0, username: "kmjdevci" },
    { uid: 995, username: "root" },
    { uid: undefined, username: "" },
  ]) {
    const result = diagnoseNonrootGit({
      identity,
      execute: () => {
        assert.fail("Git must not run for an unapproved identity");
      },
    });
    assert.equal(result.status, "DENIED_NONROOT_IDENTITY");
    assert.deepEqual(result.checks, {});
  }
});

test("fixed read-only Git commands prove HEAD ref, object and commit", () => {
  const calls = [];
  const result = diagnoseNonrootGit({
    identity: worker,
    execute: (file, args, options) => {
      calls.push({ file, args, options });
      return success(file, args);
    },
  });
  assert.equal(result.status, "DIAGNOSTIC_ONLY");
  assert.deepEqual(result.checks, {
    headRef: "PASS",
    headObject: "PASS",
    headCommit: "PASS",
  });
  assert.equal(result.permissionsChanged, false);
  assert.equal(result.productionChanged, false);
  assert.equal(result.autonomousCodingLive, false);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.file, "/usr/bin/git");
    assert.deepEqual(call.args.slice(0, 4), [
      "-c",
      "safe.directory=/srv/kmj-codebridge-projects/kmj-main-platform",
      "-C",
      "/srv/kmj-codebridge-projects/kmj-main-platform",
    ]);
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(call.options.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(call.options.env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(call.options.stdio[0], "ignore");
  }
  assert.deepEqual(
    calls.map((call) => call.args.slice(4)),
    [
      ["rev-parse", "--verify", "HEAD"],
      ["cat-file", "-t", "HEAD"],
      ["rev-parse", "--verify", "HEAD^{commit}"],
    ],
  );
});

test("Git object failure is not misreported as a successful HEAD", () => {
  const result = diagnoseNonrootGit({
    identity: worker,
    execute: (file, args) => {
      if (args.includes("cat-file")) {
        const error = new Error("git failed");
        error.stderr = Buffer.from("fatal: bad object HEAD");
        throw error;
      }
      return success(file, args);
    },
  });
  assert.equal(result.checks.headRef, "PASS");
  assert.equal(result.checks.headObject, "OBJECT_UNAVAILABLE");
  assert.equal(result.checks.headCommit, "PASS");
});

test("classifies ownership, access, repository, object and timeout failures", () => {
  const scenarios = [
    ["fatal: detected dubious ownership in repository", "UNSAFE_OWNERSHIP"],
    [
      "fatal: could not open .git/objects/aa/bb: Permission denied",
      "ACCESS_DENIED",
    ],
    ["fatal: not a git repository", "REPOSITORY_UNAVAILABLE"],
    ["fatal: bad object HEAD", "OBJECT_UNAVAILABLE"],
    ["fatal: unrelated error", "OTHER_FAILURE"],
  ];
  for (const [stderr, expected] of scenarios) {
    assert.equal(classifyGitError({ stderr }), expected);
  }
  assert.equal(classifyGitError({ code: "ETIMEDOUT" }), "TIMEOUT");
  assert.equal(classifyGitError({}), "OTHER_FAILURE");
});

test("unexpected output and stderr never disclose repository content or secrets", () => {
  const secret = "TOP_SECRET_DO_NOT_PRINT";
  const result = diagnoseNonrootGit({
    identity: worker,
    execute: (_file, args) => {
      if (args.includes("cat-file")) return "blob\n";
      const error = new Error(secret);
      error.stderr = Buffer.from(`fatal: permission denied ${secret}`);
      throw error;
    },
  });
  assert.deepEqual(result.checks, {
    headRef: "ACCESS_DENIED",
    headObject: "UNEXPECTED_OUTPUT",
    headCommit: "ACCESS_DENIED",
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("permission denied"), false);
});

test("diagnostic continues classification after a failed individual Git check", () => {
  let calls = 0;
  const result = diagnoseNonrootGit({
    identity: worker,
    execute: () => {
      calls++;
      const error = new Error("unavailable");
      error.stderr = "fatal: unknown revision";
      throw error;
    },
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.checks, {
    headRef: "OBJECT_UNAVAILABLE",
    headObject: "OBJECT_UNAVAILABLE",
    headCommit: "OBJECT_UNAVAILABLE",
  });
});
