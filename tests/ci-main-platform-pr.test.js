import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prepare = path.join(root, "scripts/ci-main-platform-pr.sh");
const worker = path.join(root, "scripts/ci-main-platform-pr-worker.sh");
const script = fs.readFileSync(prepare, "utf8");
const source = fs.readFileSync(worker, "utf8");

test("CI shell files are syntactically valid on Linux", (t) => {
  if (process.platform === "win32") return t.skip("POSIX bash syntax");
  execFileSync("bash", ["-n", prepare]);
  execFileSync("bash", ["-n", worker]);
});

test("CI exact-SHA validation rejects malformed inputs without side effects", (t) => {
  if (process.platform === "win32") return t.skip("POSIX bash execution");
  for (const args of [
    [],
    ["main"],
    ["../../main"],
    ["e".repeat(39)],
    ["e".repeat(40), "extra"],
    ["0".repeat(40) + "; touch /tmp/never-allow"],
  ]) {
    const result = spawnSync("bash", [prepare, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /CI_INVALID_SHA/);
  }
});

test("CI preparation is pinned to one private PR and trusted immutable revision", () => {
  assert.match(script, /refs\/remotes\/origin\/feat\/codebridge-owner-tier/);
  assert.match(script, /sha="\$1"/);
  assert.match(
    script,
    /rev-parse refs\/remotes\/origin\/feat\/codebridge-owner-tier/,
  );
  assert.match(script, /cat-file -t "\$sha"/);
  assert.match(script, /status --porcelain/);
  assert.match(script, /composer\.lock apps\/platform\/package-lock\.json/);
  assert.match(script, /CI_DEPENDENCY_LOCK_CONFLICT/);
  assert.match(script, /CI_UNSAFE_TRACKED_SYMLINK/);
  assert.doesNotMatch(script, /git\s+push|gh\s+pr\s+merge|git\s+merge/);
});

test("CI worker cannot run as production service user or reach network", () => {
  for (const control of [
    "User=kmjci",
    "Group=kmjci",
    "NoNewPrivileges=yes",
    "PrivateNetwork=yes",
    "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
    "IPAddressDeny=any",
    "IPAddressAllow=localhost",
    "PrivateDevices=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateTmp=yes",
    "CapabilityBoundingSet=",
    "ReadWritePaths=$job",
    "InaccessiblePaths=/srv",
    "MemoryMax=12G",
    "TasksMax=512",
    "flock -n 9",
  ])
    assert.ok(script.includes(control), control);
  assert.match(script, /\/usr\/bin\/env -i/);
  assert.match(script, /id -u kmjci/);
  assert.doesNotMatch(script, /User=kmjprod|Group=kmjprod/);
  assert.doesNotMatch(script, /\b(?:docker|podman)\s+run\b/);
});

test("CI reports latest immutable SHA-bound evidence atomically for native CodeBridge", () => {
  assert.match(script, /latest-pr322\.json/);
  assert.match(script, /chmod 0600 "\$manifest"/);
  assert.match(
    script,
    /chmod 0600 "\$base\/evidence\/\.latest-pr322\.json\.\$\$"/,
  );
  assert.match(
    script,
    /mv -f -- "\$base\/evidence\/\.latest-pr322\.json\.\$\$" "\$latest"/,
  );
  assert.match(script, /"windows": "NOT_RUN"/);
  assert.match(script, /"github_actions": "NOT_RUN"/);
});

test("CI worker preserves required gates and never claims hosted green", () => {
  for (const gate of [
    "npm run check",
    "npm run build",
    "npm run types:check",
    "vendor/bin/pint --test",
    "vendor/bin/phpunit",
    "tests/codebridge/renewal.php",
    "tests/codebridge/verify.mjs",
    "tests/codebridge/concurrency.php",
    "CODEBRIDGE_CONCURRENCY_REQUIRED=1",
  ])
    assert.ok(source.includes(gate), gate);
  assert.match(source, /CI_WORKER_UNTRUSTED_WORKSPACE/);
  assert.match(source, /KMJ_CI_PG_REQUIRED_UNAVAILABLE/);
  assert.match(script, /"github_actions": "NOT_RUN"/);
  assert.match(script, /"windows": "NOT_RUN"/);
  assert.match(script, /"signed_production": False/);
  assert.match(script, /"log_sha256"/);
  assert.match(script, /CI_GITHUB_ACTIONS=NOT_RUN/);
  assert.doesNotMatch(script, /Checks API|check-runs|\/statuses\//);
});
