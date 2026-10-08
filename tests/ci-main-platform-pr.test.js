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

test("website CI rejects symlinks even when a large tree follows the first link", (t) => {
  if (process.platform === "win32") return t.skip("POSIX bash execution");
  const content = fs.readFileSync(
    path.join(root, "scripts/ci-main-platform-pr337.sh"),
    "utf8",
  );
  const block = content.match(/tree_listing=[\s\S]*?\nfi/)[0];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-symlink-tree-"));
  try {
    const fixture = path.join(temp, "tree");
    for (const symlink of [true, false]) {
      fs.writeFileSync(
        fixture,
        (symlink ? "120000 blob abc\tlink\n" : "") +
          "100644 blob abc\tfile\n".repeat(50000),
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          'set -Eeuo pipefail; sha=fixture; git_read() { cat "$FIXTURE_TREE"; };\n' +
            block,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, FIXTURE_TREE: fixture },
          timeout: 5000,
        },
      );
      assert.equal(result.status, symlink ? 3 : 0, result.stderr);
      if (symlink) assert.match(result.stderr, /CI_UNSAFE_TRACKED_SYMLINK/);
    }
    const failed = spawnSync(
      "bash",
      [
        "-c",
        "set -Eeuo pipefail; sha=fixture; git_read() { return 128; };\n" +
          block,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(failed.status, 3);
    assert.match(failed.stderr, /CI_TREE_READ_FAILED/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("website CI staging copies content and modes without source ownership or timestamps", (t) => {
  if (process.platform === "win32") return t.skip("POSIX bash execution");
  const content = fs.readFileSync(
    path.join(root, "scripts/ci-main-platform-pr337.sh"),
    "utf8",
  );
  const block = content.match(/cp -a[^\n]*vendor[^\n]*[\s\S]*?\ndone/)[0];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-copy-metadata-"));
  try {
    const repo = path.join(temp, "repo"),
      job = path.join(temp, "job");
    const fixtures = [
      ["apps/platform/vendor/dependency", "apps/platform/vendor/dependency"],
      [
        "apps/platform/node_modules/dependency",
        "apps/platform/node_modules/dependency",
      ],
      [
        "packages/domain-fixture/src/dependency",
        "apps/platform/vendor/kmjtechno/domain-fixture/src/dependency",
      ],
    ];
    let foreignOwnership = false;
    for (const [source, destination] of fixtures) {
      const file = path.join(repo, source);
      fs.mkdirSync(path.dirname(file), { recursive: true });

      fs.writeFileSync(file, "fixture-content\n", { mode: 0o755 });
      fs.utimesSync(file, 946684800, 946684800);
      if (process.getuid() === 0) {
        const ownership = spawnSync("chown", ["65534:65534", file]);
        foreignOwnership = ownership.status === 0;
      }
    }
    fs.mkdirSync(path.join(job, "src/apps/platform"), { recursive: true });
    fs.mkdirSync(
      path.join(repo, "apps/platform/vendor/kmjtechno/domain-fixture/src"),
      { recursive: true },
    );
    const packageSource = path.join(repo, "packages/domain-fixture/src");
    fs.cpSync(
      packageSource,
      path.join(job, "src/packages/domain-fixture/src"),
      { recursive: true },
    );
    // The archived package source retains its original metadata before overlay.
    const archived = path.join(
      job,
      "src/packages/domain-fixture/src/dependency",
    );
    fs.utimesSync(archived, 946684800, 946684800);
    if (foreignOwnership) fs.chownSync(archived, 65534, 65534);
    else
      t.diagnostic(
        "Foreign-owner fixture unavailable; timestamp, mode, content and symlink behavior remain verified",
      );
    fs.symlinkSync(
      "dependency",
      path.join(repo, "apps/platform/node_modules/link"),
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        'set -Eeuo pipefail; repo="$1"; job="$2";\n' + block,
        "ci-copy",
        repo,
        job,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const [, destination] of fixtures) {
      const file = path.join(job, "src", destination),
        metadata = fs.statSync(file);
      assert.equal(fs.readFileSync(file, "utf8"), "fixture-content\n");
      assert.equal(metadata.mode & 0o777, 0o755);
      assert.equal(metadata.uid, process.getuid());
      assert.ok(
        metadata.mtimeMs > 946684800000,
        "staging must not preserve source timestamps",
      );
    }
    assert.equal(
      fs.readlinkSync(path.join(job, "src/apps/platform/node_modules/link")),
      "dependency",
    );
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
  assert.doesNotMatch(websiteUnit, /git[^\n]*fetch|systemctl start/);
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
});

test("trusted PR337 preparation has file setup capabilities while PR worker has none", () => {
  assert.match(
    websiteUnit,
    /^CapabilityBoundingSet=CAP_CHOWN CAP_DAC_OVERRIDE$/m,
  );
  assert.match(
    websiteUnit,
    /^ReadOnlyPaths=\/srv\/kmj-codebridge-projects\/kmj-main-platform \/opt\/kmj-codebridge-agent$/m,
  );
  assert.match(websiteSource, /-p CapabilityBoundingSet= \\/);
  assert.match(websiteSource, /-p User=kmjci -p Group=kmjci/);
  assert.match(websiteSource, /-p "InaccessiblePaths=\/srv/);
});

test("trusted CI evidence writers record only fixed worker failure categories and gates", (t) => {
  if (process.platform === "win32") return t.skip("Python POSIX CI writer");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-worker-evidence-"));
  try {
    for (const filename of [
      "ci-main-platform-pr.sh",
      "ci-main-platform-pr337.sh",
    ]) {
      const content = fs.readFileSync(
        path.join(root, "scripts", filename),
        "utf8",
      );
      const writer = content.match(/<<'PY'\n([\s\S]*?)\nPY/)[1];
      for (const [logText, code, failure, gate] of [
        [
          "KMJ_CI_GATE_BEGIN=public_layout\nassertion failed: NEVER_RETURN",
          1,
          "COMMAND_FAILED_UNCLASSIFIED",
          "public_layout",
        ],
        [
          "KMJ_CI_GATE_BEGIN=NEVER_RETURN\nKMJ_CI_GATE_PASS=NEVER_RETURN\nsh: 1: vp: not found",
          0,
          null,
          null,
        ],
        [
          "KMJ_CI_GATE_BEGIN=fmt_lint\nsh: 1: vp: not found\nsecret=NEVER_RETURN",
          1,
          "VP_NOT_FOUND",
          "fmt_lint",
        ],
        [
          "KMJ_CI_GATE_BEGIN=frontend_build\n/bin/bash: vp: command not found",
          127,
          "VP_NOT_FOUND",
          "frontend_build",
        ],
        [
          "Failed to start transient service unit: secret=NEVER_RETURN",
          1,
          "WORKER_SANDBOX_START_FAILED",
          null,
        ],
        [
          "KMJ_CI_GATE_BEGIN=node_lease_interop\nKMJ_CI_GATE_PASS=node_lease_interop\nKMJ_CI_PG_REQUIRED_UNAVAILABLE",
          42,
          "PG_UNAVAILABLE",
          "postgres_concurrency",
        ],
        [
          "KMJ_CI_GATE_BEGIN=php_tests\ncommand error\nKMJ_CI_GATE_BEGIN=NEVER_RETURN",
          1,
          "COMMAND_FAILED_UNCLASSIFIED",
          "php_tests",
        ],
        [
          "KMJ_CI_GATE_BEGIN=fmt_lint\nKMJ_CI_GATE_PASS=fmt_lint",
          0,
          null,
          null,
        ],
        [
          "KMJ_CI_GATE_BEGIN=fmt_lint\nKMJ_CI_GATE_PASS=fmt_lint\nunknown failure",
          1,
          "COMMAND_FAILED_UNCLASSIFIED",
          null,
        ],
      ]) {
        const log = path.join(temp, "worker.log"),
          manifest = path.join(temp, "manifest.json");
        fs.writeFileSync(log, logText);
        execFileSync("python3", [
          "-c",
          writer,
          "a".repeat(40),
          log,
          String(code),
          manifest,
          "b".repeat(40),
          "c".repeat(40),
          "d".repeat(64),
        ]);
        const record = JSON.parse(fs.readFileSync(manifest, "utf8"));
        assert.equal(record.failure_kind, failure, filename);
        assert.equal(record.failed_gate, gate, filename);
        assert.doesNotMatch(JSON.stringify(record), /NEVER_RETURN|secret=/);
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("public layout preflight runs the existing checker when present and retains npm check", (t) => {
  if (process.platform === "win32") return t.skip("POSIX worker gate");
  const block = source.match(
    /if \[\[ -f scripts\/check-public-layout\.mjs \]\]; then\n[\s\S]*?\nfi/,
  );
  assert.ok(block);
  assert.ok(
    source.indexOf(block[0]) < source.indexOf("gate fmt_lint npm run check"),
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kmj-public-layout-gate-"),
  );
  try {
    fs.mkdirSync(path.join(directory, "scripts"));
    const run = () =>
      spawnSync(
        "bash",
        [
          "-c",
          'set -e; gate() { label=$1; shift; echo BEGIN=$label; "$@"; echo PASS=$label; };\n' +
            block[0],
        ],
        { cwd: directory, encoding: "utf8" },
      );
    assert.equal(run().stdout, "");
    fs.writeFileSync(
      path.join(directory, "scripts/check-public-layout.mjs"),
      'import assert from "node:assert/strict"; assert.equal(1, 2);',
    );
    const failed = run();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stdout, /BEGIN=public_layout/);
    assert.doesNotMatch(failed.stdout, /PASS=public_layout/);
    fs.writeFileSync(
      path.join(directory, "scripts/check-public-layout.mjs"),
      'import assert from "node:assert/strict"; assert.equal(1, 1);',
    );
    const passed = run();
    assert.equal(passed.status, 0, passed.stderr);
    assert.match(passed.stdout, /PASS=public_layout/);
    assert.match(source, /gate fmt_lint npm run check/);
    assert.match(script, /"public_layout"/);
    assert.match(websiteSource, /"public_layout"/);
    assert.match(
      websiteFixedSource,
      /70a5efb9a43103cd17be15d056e166cb19813efe/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
