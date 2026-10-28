import test from "node:test";
import assert from "node:assert/strict";

import {
  attestIsolatedDevelopmentSource,
  ISOLATED_SOURCE,
  ISOLATED_SOURCE_ROOT,
} from "../scripts/production/attest-isolated-development-source.mjs";

const revision = "a".repeat(40);
const identity = { uid: 995, username: "kmjdevci" };

function fixture(overrides = {}) {
  const calls = [];
  const roots = new Set(["/var", "/var/lib"]);
  const lstat = (path) => {
    if (overrides.missing === path) throw Error("SOURCE_MISSING");
    const root = roots.has(path);
    const unsafe = overrides.unsafe === path;
    return {
      uid: unsafe ? 0 : root ? 0 : identity.uid,
      mode: unsafe ? 0o40777 : root ? 0o40755 : 0o40700,
      isDirectory: () => true,
      isSymbolicLink: () => overrides.symlink === path,
    };
  };
  const execute = (file, args, options) => {
    calls.push({ file, args, options });
    if (overrides.fail) {
      const error = Error("redacted");
      error.stderr = Buffer.from(overrides.fail);
      throw error;
    }
    if (args.includes("cat-file")) {
      return overrides.objectType ?? "commit\n";
    }
    if (args.some((arg) => arg.endsWith("^{commit}"))) {
      return overrides.commit ?? `${revision}\n`;
    }
    if (args.includes("rev-parse") && calls.length === 4) {
      return overrides.changed ?? `${revision}\n`;
    }
    return overrides.head ?? `${revision}\n`;
  };
  return {
    calls,
    verify: (input = {}) =>
      attestIsolatedDevelopmentSource({
        identity,
        expectedHead: revision,
        lstat,
        execute,
        ...input,
      }),
  };
}

test("source attestation is offline, exact-path, nonroot and never activates a service", () => {
  const f = fixture();
  const r = f.verify();
  assert.equal(r.reason, "PINNED_SOURCE_READABLE");
  assert.equal(r.sourceConsistent, true);
  assert.equal(r.serviceEnabled, false);
  assert.equal(r.productionApproved, false);
  assert.equal(r.autonomousCodingLive, false);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(
    f.calls.map((call) => call.args),
    [
      ["-C", ISOLATED_SOURCE, "rev-parse", "--verify", "HEAD"],
      ["-C", ISOLATED_SOURCE, "cat-file", "-t", revision],
      ["-C", ISOLATED_SOURCE, "rev-parse", "--verify", `${revision}^{commit}`],
      ["-C", ISOLATED_SOURCE, "rev-parse", "--verify", "HEAD"],
    ],
  );
  for (const { file, args, options } of f.calls) {
    assert.equal(file, "/usr/bin/git");
    assert.equal(options.timeout, 5000);
    assert.equal(options.env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(options.env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(args.some((v) => String(v).includes("safe.directory")), false);
    assert.equal(
      args.some((v) => String(v).includes("/srv/kmj-codebridge-projects")),
      false,
    );
  }
});

test("missing identity or pinned SHA fails before Git is invoked", () => {
  const f = fixture();
  for (const bad of [undefined, { uid: 0, username: "root" }, { uid: 33, username: "www-data" }]) {
    assert.equal(
      f.verify({ identity: bad }).reason,
      "WORKER_IDENTITY_UNVERIFIED",
    );
  }
  for (const sha of [undefined, "", "../HEAD", "b".repeat(39), "B".repeat(40)]) {
    assert.equal(f.verify({ expectedHead: sha }).reason, "PINNED_COMMIT_REQUIRED");
  }
  assert.equal(f.calls.length, 0);
});

test("new source must have private worker-owned directories and root-owned ancestors", () => {
  const targets = [
    "/var",
    "/var/lib",
    ISOLATED_SOURCE_ROOT,
    ISOLATED_SOURCE,
    `${ISOLATED_SOURCE}/.git`,
    `${ISOLATED_SOURCE}/.git/objects`,
    `${ISOLATED_SOURCE}/.git/refs`,
  ];
  for (const path of targets) {
    for (const bad of [{ unsafe: path }, { symlink: path }]) {
      const f = fixture(bad);
      assert.equal(f.verify().reason, "SOURCE_DIRECTORY_UNSAFE", path);
      assert.equal(f.calls.length, 0, path);
    }
    const missing = fixture({ missing: path });
    assert.equal(missing.verify().reason, "ISOLATED_SOURCE_UNAVAILABLE", path);
    assert.equal(missing.calls.length, 0, path);
  }
});

test("object availability, revision mismatch, and concurrent ref move all fail closed", () => {
  const scenarios = [
    [{ objectType: "blob\n" }, "COMMIT_OBJECT_UNAVAILABLE"],
    [{ head: `${"b".repeat(40)}\n` }, "PINNED_HEAD_MISMATCH"],
    [{ commit: `${"b".repeat(40)}\n` }, "COMMIT_MISMATCH"],
    [{ changed: `${"b".repeat(40)}\n` }, "SOURCE_HEAD_CHANGED"],
    [{ fail: "fatal: detected dubious ownership in repository" }, "UNSAFE_OWNERSHIP"],
    [{ fail: "fatal: permission denied /sensitive/path" }, "ACCESS_DENIED"],
  ];
  for (const [option, expected] of scenarios) {
    const f = fixture(option);
    const verdict = f.verify();
    assert.equal(verdict.reason, expected);
    assert.equal(verdict.sourceConsistent, false);
    assert.equal(verdict.productionApproved, false);
    assert.equal(JSON.stringify(verdict).includes("/sensitive/path"), false);
  }
});
