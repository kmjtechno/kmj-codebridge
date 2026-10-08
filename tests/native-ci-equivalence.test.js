import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSupervisorHandler } from "../src/supervisor.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const worker = fs.readFileSync(
  path.join(root, "scripts/ci-main-platform-pr-worker.sh"),
  "utf8",
);
const parents = ["ci-main-platform-pr.sh", "ci-main-platform-pr337.sh"];

test("missing native Rust prerequisite fails its real named gate", (t) => {
  if (process.platform === "win32") return t.skip("POSIX worker");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "native-rust-fail-"));
  try {
    const tool = path.join(temp, "cargo");
    fs.writeFileSync(tool, "#!/bin/sh\nexit 37\n");
    fs.chmodSync(tool, 0o755);
    const gate = worker.match(/gate\(\) \{[\s\S]*?\n\}/)[0];
    const line = worker
      .split("\n")
      .find((x) => x.startsWith("gate rust_tests "));
    const result = spawnSync("bash", ["-ec", gate + "\n" + line], {
      encoding: "utf8",
      env: { ...process.env, PATH: temp + path.delimiter + process.env.PATH },
      timeout: 5000,
    });
    assert.equal(result.status, 37);
    assert.match(result.stdout, /KMJ_CI_GATE_BEGIN=rust_tests/);
    assert.doesNotMatch(result.stdout, /KMJ_CI_GATE_PASS=rust_tests/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("native worker retains hosted PHP, Rust, policy and PostgreSQL assertions", () => {
  for (const command of [
    "php artisan config:clear --ansi",
    "php vendor/bin/phpstan analyse",
    "cargo fmt --manifest-path services/license-core/Cargo.toml --check",
    "cargo test --offline --locked --manifest-path services/license-core/Cargo.toml",
    "bash contracts/kslp-v1/verify-contract.sh",
    "tests.test_persistent_worker",
    "tests.test_codebridge_github_proxy",
    "scripts/test_restore_verification_contract.py",
    "scripts/verify_delivery_progress.py",
    "scripts/verify_runtime.py",
    "scripts/verify_free_router.py",
    "pg_virtualenv -v 17",
    'grep -Fq "SKIP:"',
  ])
    assert.ok(worker.includes(command), command);
  assert.match(worker, /CARGO_NET_OFFLINE=true/);
  assert.match(worker, /KMJ_PROGRESS_BASE_SHA/);
  assert.match(worker, /=== 22/);
  assert.match(worker, /=== 24/);
});

test("isolated Git history supports existing head/base diff without source credentials", (t) => {
  if (process.platform === "win32") return t.skip("POSIX Git fixture");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "native-git-history-"));
  try {
    const repo = path.join(temp, "repo"),
      job = path.join(temp, "job");
    fs.mkdirSync(repo);
    fs.mkdirSync(path.join(job, "src"), { recursive: true });
    const git = (...args) =>
      execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q");
    fs.writeFileSync(path.join(repo, "file"), "base");
    git("add", ".");
    git(
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "base",
    );
    const base = git("rev-parse", "HEAD").trim();
    fs.writeFileSync(path.join(repo, "file"), "head");
    git("add", ".");
    git(
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "-qm",
      "head",
    );
    const sha = git("rev-parse", "HEAD").trim();
    git("config", "http.extraheader", "secret-never-copy");
    git("checkout", "-q", base);
    fs.writeFileSync(path.join(job, "src/file"), "head");
    const poison = path.join(temp, "poison-template");
    fs.mkdirSync(poison);
    fs.writeFileSync(
      path.join(poison, "private-template-secret"),
      "must-never-copy",
    );
    const global = path.join(temp, "poison-global");
    fs.writeFileSync(global, `[init]\n templateDir = ${poison}\n`);
    const parent = fs.readFileSync(
      path.join(root, "scripts", parents[0]),
      "utf8",
    );
    const helper = parent.match(/git_read\(\) \{[\s\S]*?\n\}/)[0];
    const block = parent.match(
      /base_sha="[\s\S]*?printf '%s\\n' "\$base_sha" > "\$job\/src\/\.ci-base-sha"/,
    )[0];
    const result = spawnSync(
      "bash",
      [
        "-ec",
        'repo="$1"; job="$2"; sha="$3";\n' + helper + "\n" + block,
        "history",
        repo,
        job,
        sha,
      ],
      { encoding: "utf8", timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    const diff = execFileSync(
      "git",
      ["-C", path.join(job, "src"), "diff", "--name-only", `${base}...${sha}`],
      { encoding: "utf8" },
    );
    assert.equal(diff.trim(), "file");
    const staged = execFileSync(
      "git",
      ["-C", path.join(job, "src"), "ls-files", "--cached"],
      { encoding: "utf8" },
    );
    assert.equal(staged.trim(), "file");
    const clean = execFileSync(
      "git",
      ["-C", path.join(job, "src"), "diff", "HEAD", "--", "file"],
      { encoding: "utf8" },
    );
    assert.equal(clean, "");
    assert.equal(
      fs.existsSync(path.join(job, "src/.git/private-template-secret")),
      false,
    );
    assert.match(block, /GIT_CONFIG_GLOBAL=\/dev\/null/);
    assert.match(block, /git init -q --template=/);
    assert.doesNotMatch(
      fs.readFileSync(path.join(job, "src/.git/config"), "utf8"),
      /secret-never-copy|extraheader/,
    );
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("trusted manifests and readback retain new failure gates and producer/consumer provenance", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX Python evidence");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "native-gate-evidence-"));
  try {
    for (const filename of parents) {
      const source = fs.readFileSync(
        path.join(root, "scripts", filename),
        "utf8",
      );
      const writer = source.match(/<<'PY'\n([\s\S]*?)\nPY/)[1];
      const log = path.join(temp, "worker.log"),
        output = path.join(temp, "evidence.json");
      fs.writeFileSync(
        log,
        "KMJ_CI_GATE_BEGIN=php_static_analysis\nKMJ_CI_RUNTIME_PHP=8.4.10\nKMJ_CI_RUNTIME_CARGO=UNAVAILABLE\nKMJ_CI_RUNTIME_NODE_PLATFORM=secret-invalid\nsecret details stay in bounded private log\n",
      );
      execFileSync("python3", [
        "-c",
        writer,
        "a".repeat(40),
        log,
        "1",
        output,
        "b".repeat(40),
        "c".repeat(40),
        "d".repeat(64),
      ]);
      const record = JSON.parse(fs.readFileSync(output, "utf8"));
      assert.equal(record.failed_gate, "php_static_analysis");
      assert.equal(record.base_sha, "b".repeat(40));
      assert.equal(record.consumer_sha, "c".repeat(40));
      const handler = createSupervisorHandler({
        run: () => "LoadState=loaded\n",
        lstat: () => ({
          isFile: () => true,
          isSymbolicLink: () => false,
          uid: 0,
          nlink: 1,
          mode: 0o100600,
          size: 1000,
        }),
        readFile: () => JSON.stringify(record),
      });
      const result = (await handler({ op: `private_pr${record.pr}_ci_status` }))
        .response.last;
      assert.deepEqual(result.runtimeVersions, {
        PHP: "8.4.10",
        CARGO: "UNAVAILABLE",
      });
      assert.equal(result.consumerSha, "c".repeat(40));
      assert.equal(result.baseSha, "b".repeat(40));
      assert.equal(result.failedGate, "php_static_analysis");
      for (const field of [
        "base_sha",
        "consumer_sha",
        "consumer_license_sha256",
      ]) {
        const valid = record[field];
        record[field] = [valid];
        assert.equal(
          (await handler({ op: `private_pr${record.pr}_ci_status` })).response
            .last,
          null,
        );
        record[field] = valid;
      }
      record.gate_markers = ["php_static_analysis", "php_static_analysis"];
      assert.equal(
        (await handler({ op: `private_pr${record.pr}_ci_status` })).response
          .last,
        null,
      );
      record.gate_markers = [];
      record.runtime_versions.NODE_PLATFORM = ["22.0.0"];
      assert.equal(
        (await handler({ op: `private_pr${record.pr}_ci_status` })).response
          .last,
        null,
      );
      delete record.runtime_versions.NODE_PLATFORM;
      record.consumer_sha = "secret-invalid";
      assert.equal(
        (await handler({ op: `private_pr${record.pr}_ci_status` })).response
          .last,
        null,
      );
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("runtime markers expose bounded versions and suppress arbitrary tool output", (t) => {
  if (process.platform === "win32") return t.skip("POSIX runtime marker");
  const helper = worker.match(/runtime_version\(\) \{[\s\S]*?\n\}/)[0];
  const result = spawnSync(
    "bash",
    [
      "-ec",
      helper +
        "\nruntime_version PHP printf 8.4.10\nruntime_version CARGO printf secret-private-path\nruntime_version POSTGRES false\n",
    ],
    { encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "KMJ_CI_RUNTIME_PHP=8.4.10\nKMJ_CI_RUNTIME_CARGO=UNAVAILABLE\nKMJ_CI_RUNTIME_POSTGRES=UNAVAILABLE\n",
  );
  assert.doesNotMatch(result.stdout, /secret-private/);
});
