import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSupervisorHandler } from "../src/supervisor.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const validator = path.join(root, "scripts/validate-native-ci-cache.py");
function fixture(t) {
  const dir = fs.mkdtempSync(
    path.join(
      process.getuid?.() === 0 ? "/opt" : os.tmpdir(),
      "kmj-prereq-cache-",
    ),
  );
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const source = path.join(dir, "cargo"),
    dest = path.join(dir, "sealed"),
    lock = path.join(dir, "Cargo.lock");
  const registry = "index.crates.io-fixture";
  const crate = Buffer.from("locked crate artifact");
  fs.mkdirSync(path.join(source, "registry/cache", registry), {
    recursive: true,
  });
  fs.mkdirSync(path.join(source, "registry/index", registry), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(source, "registry/cache", registry, "fixture-1.0.0.crate"),
    crate,
  );
  fs.writeFileSync(
    path.join(source, "registry/index", registry, "config.json"),
    JSON.stringify({
      dl: "https://static.crates.io/crates",
      api: "https://crates.io",
    }),
  );
  fs.writeFileSync(path.join(source, "credentials.toml"), "secret-never-copy");
  fs.writeFileSync(
    lock,
    `version = 4\n[[package]]\nname = "fixture"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "${crypto.createHash("sha256").update(crate).digest("hex")}"\n`,
  );
  return { dir, source, dest, lock, registry };
}
function run(...args) {
  return spawnSync("python3", [validator, ...args], {
    encoding: "utf8",
    timeout: 10000,
  });
}
test("Cargo cache seals only checksum-matched public registry artifacts", (t) => {
  if (process.platform === "win32") return t.skip("Python POSIX cache");
  const f = fixture(t);
  const r = run("seal", f.source, f.lock, f.dest);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(f.dest, "credentials.toml")), false);
  if (process.getuid?.() === 0)
    assert.equal(run("verify", f.dest, f.lock).status, 0);
  else assert.notEqual(run("verify", f.dest, f.lock).status, 0);
  fs.chmodSync(
    path.join(f.dest, "registry/cache", f.registry, "fixture-1.0.0.crate"),
    0o644,
  );
  fs.writeFileSync(
    path.join(f.dest, "registry/cache", f.registry, "fixture-1.0.0.crate"),
    "tampered",
  );
  assert.notEqual(run("verify", f.dest, f.lock).status, 0);
});
test("Cargo cache rejects foreign registries, artifact corruption and symlinks", (t) => {
  if (process.platform === "win32") return t.skip("Python POSIX cache");
  for (const attack of ["registry", "checksum", "symlink"]) {
    const f = fixture(t);
    if (attack === "registry")
      fs.writeFileSync(
        f.lock,
        fs
          .readFileSync(f.lock, "utf8")
          .replace(
            "https://github.com/rust-lang/crates.io-index",
            "https://private.example.invalid/index",
          ),
      );
    if (attack === "checksum")
      fs.writeFileSync(
        path.join(
          f.source,
          "registry/cache",
          f.registry,
          "fixture-1.0.0.crate",
        ),
        "wrong",
      );
    if (attack === "symlink")
      fs.symlinkSync(
        f.lock,
        path.join(f.source, "registry/index", f.registry, "private-link"),
      );
    const r = run("seal", f.source, f.lock, f.dest);
    assert.notEqual(r.status, 0, attack);
    assert.doesNotMatch(
      r.stdout + r.stderr,
      /secret-never-copy|private\.example/,
    );
  }
});

test("prerequisite installer pins vendor artifacts and never runs privileged Cargo or cluster setup", () => {
  const installer = fs.readFileSync(
    path.join(root, "scripts/install-native-ci-prerequisites.sh"),
    "utf8",
  );
  const builder = fs.readFileSync(
    path.join(root, "scripts/ci-prerequisites-build.sh"),
    "utf8",
  );
  assert.equal((installer.match(/^fetch .* [a-f0-9]{64}$/gm) || []).length, 5);
  assert.match(installer, /User=kmjci-build/);
  assert.match(installer, /install -o root -g root -m 0444.*builder_stage/);
  assert.match(installer, /bin\/bash "\$builder_stage\/build.sh"/);
  assert.doesNotMatch(
    installer,
    /bin\/bash "\$runtime\/ci-prerequisites-build.sh"/,
  );
  assert.match(installer, /CapabilityBoundingSet= /);
  assert.match(installer, /--user-group/);
  assert.match(installer, /CI_PREREQUISITES_LOCK_CHANGED/);
  assert.match(installer, /MemoryMax=2G/);
  assert.match(installer, /RuntimeMaxSec=1200/);
  assert.doesNotMatch(
    installer,
    /apt-get|pg_createcluster|systemctl start postgresql|cargo fetch/,
  );
  assert.match(builder, /env -i PATH=.*cargo.* fetch --locked --manifest-path/);
  assert.match(installer, /mv -- "\$publish" "\$prefix"/);
  assert.match(installer, /CI_PREREQUISITES_ALREADY_INSTALLED/);
  for (const name of ["ci-main-platform-pr.sh", "ci-main-platform-pr337.sh"]) {
    const prep = fs.readFileSync(path.join(root, "scripts", name), "utf8");
    assert.match(prep, /verify "\$cargo_cache" "\$cargo_lock"/);
    assert.match(prep, /CI_TRUSTED_CACHE_VALIDATOR_INVALID/);
    assert.match(
      prep,
      /cp -a --no-preserve=ownership,timestamps "\$cargo_cache\/registry"/,
    );
  }
});

test("sealed cache rejects lock changes and writable publication directories", (t) => {
  if (process.platform === "win32") return t.skip("Python POSIX cache");
  const f = fixture(t);
  assert.equal(run("seal", f.source, f.lock, f.dest).status, 0);
  fs.chmodSync(f.dest, 0o777);
  assert.notEqual(run("verify", f.dest, f.lock).status, 0);
  fs.chmodSync(f.dest, 0o755);
  fs.writeFileSync(
    f.lock,
    fs.readFileSync(f.lock, "utf8") + "\n# changed reviewed lock\n",
  );
  const r = run("verify", f.dest, f.lock);
  assert.equal(r.status, 3);
  assert.doesNotMatch(r.stderr, /Traceback|secret/);
});

test("runtime publication refuses missing outputs and unsafe binaries", (t) => {
  if (process.platform === "win32") return t.skip("Python POSIX runtime");
  const f = fixture(t);
  const runtime = path.join(f.dir, "runtime");
  assert.equal(run("runtime", runtime).status, 3);
  fs.mkdirSync(runtime);
  fs.writeFileSync(
    path.join(runtime, "vendor-version"),
    "rust1.90.0-pg17.10-v1\n",
  );
  const names = [
    "rust/bin/cargo",
    "rust/bin/rustc",
    "rust/bin/rustfmt",
    "postgres/bin/postgres",
    "postgres/bin/initdb",
    "postgres/bin/pg_ctl",
    "postgres/bin/psql",
  ];
  for (const name of names) {
    fs.mkdirSync(path.dirname(path.join(runtime, name)), { recursive: true });
    fs.writeFileSync(path.join(runtime, name), "fixture", { mode: 0o755 });
  }
  assert.equal(
    run("runtime", runtime).status,
    process.getuid?.() === 0 ? 0 : 3,
  );
  fs.chmodSync(path.join(runtime, names[0]), 0o4777);
  assert.equal(run("runtime", runtime).status, 3);
});

test("prerequisite readback exposes only fixed trusted states and missing tool enums", async () => {
  const filename = "/var/lib/kmj-codebridge-ci/prerequisites/status.json";
  for (const [record, expected] of [
    [
      { schema: 1, state: "FAILED", missingTool: "BISON" },
      { state: "FAILED", missingTool: "BISON" },
    ],
    [
      { schema: 1, state: "READY", missingTool: "" },
      { state: "READY", missingTool: null },
    ],
    [{ schema: 1, state: "FAILED", missingTool: "secret-never-expose" }, null],
    [{ schema: 1, state: "READY", missingTool: "CC" }, null],
    [{ schema: 1, state: "FAILED", missingTool: ["CC"] }, null],
    [{ schema: 1, state: "secret-never-expose", missingTool: "" }, null],
  ]) {
    const handle = createSupervisorHandler({
      run: () => ({ status: 0, stdout: "", stderr: "" }),
      lstat: (file) => {
        if (file !== filename) throw Error("missing");
        return {
          uid: 0,
          nlink: 1,
          mode: 0o100600,
          size: 100,
          isFile: () => true,
          isSymbolicLink: () => false,
        };
      },
      readFile: (file) => {
        assert.equal(file, filename);
        return JSON.stringify(record);
      },
    });
    const result = (await handle({ op: "update_status" })).response;
    assert.deepEqual(result.nativeCiPrerequisites, expected);
    assert.doesNotMatch(JSON.stringify(result), /secret-never-expose/);
  }
});

test("only exact internal PostgreSQL vendor SONAME links can be published", (t) => {
  if (process.platform === "win32") return t.skip("POSIX vendor library links");
  const f = fixture(t),
    rust = path.join(f.dir, "rust"),
    pg = path.join(f.dir, "pg"),
    lib = path.join(pg, "lib");
  fs.mkdirSync(rust);
  fs.writeFileSync(path.join(rust, "regular"), "fixture");
  fs.mkdirSync(lib, { recursive: true });
  for (const [name, major] of [
    ["pq", "5"],
    ["ecpg", "6"],
    ["ecpg_compat", "3"],
    ["pgtypes", "3"],
  ]) {
    const target = `lib${name}.so.${major}.17`;
    fs.writeFileSync(path.join(lib, target), "vendor library fixture");
    for (const alias of [`lib${name}.so`, `lib${name}.so.${major}`])
      fs.symlinkSync(target, path.join(lib, alias));
  }
  assert.equal(run("outputs", rust, pg).status, 0);
  const alias = path.join(lib, "libpq.so");
  fs.unlinkSync(alias);
  fs.symlinkSync("/etc/passwd", alias);
  assert.equal(run("outputs", rust, pg).status, 3);
  fs.unlinkSync(alias);
  fs.symlinkSync("libpq.so.5", alias);
  assert.equal(run("outputs", rust, pg).status, 3);
  fs.unlinkSync(alias);
  fs.symlinkSync("libpq.so.5.17", alias);
  fs.symlinkSync("regular", path.join(rust, "linked"));
  assert.equal(run("outputs", rust, pg).status, 3);
});

test("explicit installer failure records FAILED rather than stale INSTALLING", (t) => {
  if (process.platform === "win32") return t.skip("POSIX EXIT trap");
  const f = fixture(t);
  const source = fs.readFileSync(
    path.join(root, "scripts/install-native-ci-prerequisites.sh"),
    "utf8",
  );
  const writer = source.match(/write_state\(\) \{[\s\S]*?\n\}/)?.[0];
  const finish = source.match(/finish_prerequisite\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(writer);
  assert.ok(finish);
  const script = `set -euo pipefail\nbase="$1"; prefix="$1/prefix"; work=""; builder_stage=""; publish=""; cache_stage=""; missing_tool="BISON"\n${writer}\n${finish}\ntrap finish_prerequisite EXIT\nwrite_state INSTALLING ""\nexit 3`;
  const r = spawnSync("bash", ["-c", script, "fixture", f.dir], {
    encoding: "utf8",
    timeout: 5000,
  });
  assert.equal(r.status, 3, r.stderr);
  const status = path.join(f.dir, "status.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(status, "utf8")), {
    schema: 1,
    state: "FAILED",
    missingTool: "BISON",
  });
  assert.equal(fs.statSync(status).mode & 0o777, 0o600);
});

test("CURRENT retries only the trusted fixed installer after refresh and before CI scheduling", () => {
  const source = fs.readFileSync(
    path.join(root, "scripts/auto-update-development.sh"),
    "utf8",
  );
  const current = source.slice(
    source.indexOf('if [[ "$current" == "$remote" ]]; then'),
  );
  assert.ok(
    current.indexOf("refresh_fixed_private_ci_refs") <
      current.indexOf("retry_fixed_native_ci_prerequisites"),
  );
  assert.ok(
    current.indexOf("retry_fixed_native_ci_prerequisites") <
      current.indexOf("retry_fixed_private_ci"),
  );
  assert.match(
    source,
    /env -i PATH=\/usr\/bin:\/bin:\/usr\/sbin:\/sbin LANG=C.UTF-8 \/bin\/bash \/opt\/kmj-codebridge-agent\/scripts\/install-native-ci-prerequisites.sh/,
  );
  const installer = fs.readFileSync(
    path.join(root, "scripts/install-native-ci-prerequisites.sh"),
    "utf8",
  );
  assert.ok(
    installer.indexOf("CI_PREREQUISITES_ALREADY_INSTALLED") <
      installer.indexOf("CI_PREREQUISITES_ALREADY_ATTEMPTED"),
  );
  assert.ok(
    installer.indexOf("CI_PREREQUISITES_BUILD_TOOL_MISSING=") <
      installer.indexOf("CI_PREREQUISITES_ALREADY_ATTEMPTED"),
  );
});

test("expensive vendor attempt marker is private and blocks an unchanged tuple", (t) => {
  if (process.platform === "win32") return t.skip("POSIX attempt marker");
  if (process.getuid?.() !== 0) return t.skip("root-owned attempt marker");
  const f = fixture(t),
    source = fs.readFileSync(
      path.join(root, "scripts/install-native-ci-prerequisites.sh"),
      "utf8",
    );
  const python = source.match(
    /<<'ATTEMPT_META'\n([\s\S]*?)\nATTEMPT_META/,
  )?.[1];
  assert.ok(python);
  const invoke = (sha) =>
    spawnSync("python3", ["-I", "-c", python, f.dir, sha, "b".repeat(64)], {
      encoding: "utf8",
      timeout: 5000,
    });
  assert.equal(invoke("a".repeat(40)).status, 0);
  assert.equal(
    fs.statSync(path.join(f.dir, "attempt.json")).mode & 0o777,
    0o600,
  );
  assert.equal(invoke("a".repeat(40)).status, 3);
  assert.equal(invoke("c".repeat(40)).status, 0);
  fs.writeFileSync(
    path.join(f.dir, "attempt.json"),
    JSON.stringify({ schema: 1, sha: ["c".repeat(40)], lock: "b".repeat(64) }),
  );
  assert.equal(invoke("c".repeat(40)).status, 3);
});
