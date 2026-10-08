import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const prepare = path.join(root, "scripts/ci-main-platform-pr.sh");
const worker = path.join(root, "scripts/ci-main-platform-pr-worker.sh");
const script = fs.readFileSync(prepare, "utf8");
const source = fs.readFileSync(worker, "utf8");

test("website CI lock reads ignore inherited Git repository overrides", (t) => {
  if (process.platform === "win32") return t.skip("POSIX bash execution");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-git-env-"));
  try {
    const repo = path.join(temp, "source"),
      decoy = path.join(temp, "decoy");
    for (const dir of [repo, decoy]) {
      fs.mkdirSync(dir);
      execFileSync("git", ["-C", dir, "init", "-q"]);
    }
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    fs.mkdirSync(path.join(repo, "apps/platform"), { recursive: true });
    for (const name of ["composer.lock", "package-lock.json"])
      fs.writeFileSync(
        path.join(repo, "apps/platform", name),
        '{"locked":true}\n',
      );
    git("add", ".");
    git(
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
    const sha = git("rev-parse", "HEAD").trim();
    const content = fs.readFileSync(
      path.join(root, "scripts/ci-main-platform-pr337.sh"),
      "utf8",
    );
    const helper = content.match(/git_read\(\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    const block = content.match(
      /for file in apps\/platform\/composer.lock[\s\S]*?\ndone/,
    )[0];
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -Eeuo pipefail; repo="$1"; sha="$2";\n' + helper + "\n" + block,
        "ci-lock",
        repo,
        sha,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: path.join(decoy, ".git"),
          GIT_WORK_TREE: decoy,
        },
        timeout: 5000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

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

const siteScript = (filename) => path.join(root, "scripts", filename);
const websitePrepare = siteScript("ci-main-platform-pr337.sh");
const websiteFixed = siteScript("ci-main-platform-pr337-fixed.sh");
const websiteInstaller = siteScript("install-private-pr337-ci-unit.sh");
const websiteSource = fs.readFileSync(websitePrepare, "utf8");
const websiteFixedSource = fs.readFileSync(websiteFixed, "utf8");
const websiteUnit = fs.readFileSync(websiteInstaller, "utf8");

test("PR337 verifier refuses caller-selected refs", (t) => {
  if (process.platform === "win32") return t.skip("POSIX shell test");
  for (const file of [websitePrepare, websiteFixed, websiteInstaller]) {
    execFileSync("bash", ["-n", file]);
  }
  for (const args of [["main"], ["a".repeat(40)], ["--ref", "main"]]) {
    const result = spawnSync("bash", [websiteFixed, ...args], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 2, result.stderr);
  }
});

test("PR337 local CI pins source and isolates production", () => {
  const fixedRef =
    "refs/remotes/origin/fix/public-marketing-standalone-nav-20261008";
  assert.ok(websitePrepare.includes("pr337"));
  assert.ok(websiteSource.includes(fixedRef));
  assert.ok(websiteFixedSource.includes(fixedRef));
  assert.match(websiteFixedSource, /EUID.*-eq 0.*# -eq 0/);
  assert.match(websiteFixedSource, /KMJ_CI_FIXED_REF_LOOKUP_FAILED/);
  assert.match(websiteSource, /"pr": 337/);
  assert.match(websiteSource, /latest-pr337\.json/);
  for (const item of [
    "User=kmjci",
    "PrivateNetwork=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "IPAddressDeny=any",
    "InaccessiblePaths=/srv",
    "CI_DEPENDENCY_LOCK_CONFLICT",
    "CI_UNSAFE_TRACKED_SYMLINK",
    '"github_actions": "NOT_RUN"',
    '"windows": "NOT_RUN"',
    '"signed_production": False',
  ]) {
    assert.ok(websiteSource.includes(item), item);
  }
  const forbidden = /git\s+push|gh\s+pr\s+merge|git\s+merge/;
  assert.doesNotMatch(websiteSource, forbidden);
  assert.doesNotMatch(websiteFixedSource, forbidden);
});

test("PR337 service is independent of PR322 and hardened", () => {
  assert.match(websiteUnit, /kmj-codebridge-private-pr337-ci\.service/);
  assert.match(websiteUnit, /ci-main-platform-pr337-fixed\.sh/);
  assert.match(websiteUnit, /ci-main-platform-pr337\.sh/);
  assert.match(websiteUnit, /PRIVATE_WEBSITE_CI_ORIGIN_MISMATCH/);
  assert.match(websiteUnit, /PRIVATE_WEBSITE_CI_REF_REFRESH_FAILED/);
  assert.match(websiteUnit, /timeout 45s git/);
  assert.ok(
    websiteUnit.includes(
      "refs/heads/fix/public-marketing-standalone-nav-20261008:" +
        "refs/remotes/origin/fix/public-marketing-standalone-nav-20261008",
    ),
  );
  for (const item of [
    "Type=oneshot",
    "PrivateNetwork=true",
    "ProtectSystem=strict",
    "NoNewPrivileges=true",
    "ReadWritePaths=/var/lib/kmj-codebridge-ci",
    "InaccessiblePaths=/etc/kmj-codebridge-main-platform",
    "CapabilityBoundingSet=",
  ]) {
    assert.ok(websiteUnit.includes(item), item);
  }
  assert.doesNotMatch(websiteUnit, /systemctl\s+enable|WantedBy=/);
  assert.match(
    websiteUnit,
    /systemctl start --no-block kmj-codebridge-private-pr337-ci\.service/,
  );
  assert.match(websiteUnit, /PRIVATE_WEBSITE_CI_START_ACCEPTED=1/);
});
