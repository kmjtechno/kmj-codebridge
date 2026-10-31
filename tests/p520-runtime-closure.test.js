import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  linkSync,
  truncateSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildManifest,
  verifyRuntime,
  verifyNode,
  verifyEnrollment,
  manifestSha256,
  ClosureError,
  canonicalJson,
  assertCleanNodeEnvironment,
  sha256File,
  MAX_FILE_BYTES,
} from "../scripts/windows/runtime-closure.js";

const BINDING = (nodeSha256) => ({
  tenant: "tenant_1",
  deviceId: "kmj-kmj-codebridge-desktop-5fvjmet",
  projectId: "kmj-codebridge",
  nodeSha256,
});
const NODE_SHA = "a".repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kmj-closure-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "scripts/windows"), { recursive: true });
  mkdirSync(join(root, "node_modules/zod"), { recursive: true });
  writeFileSync(join(root, "src/cli.js"), "console.log('ok')\n");
  writeFileSync(join(root, "node_modules/zod/package.json"), '{"name":"zod"}');
  writeFileSync(join(root, "package.json"), "{}");
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(
    join(root, "scripts/windows/ONE-CLICK-ANY-DEVICE.ps1"),
    "# launcher\n",
  );
  const manifest = buildManifest(root, BINDING(NODE_SHA));
  return { root, manifest, pin: manifestSha256(manifest) };
}
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ClosureError, String(e));
    return e.code;
  }
  return "NO_ERROR";
};

test("clean runtime matching the owner-approved manifest verifies", () => {
  const f = fixture();
  assert.equal(verifyRuntime(f.root, f.manifest, f.pin), true);
  assert.equal(
    canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }),
    '{"a":[2,{"c":2,"d":1}],"b":1}',
  );
  rmSync(f.root, { recursive: true });
});

test("untracked poisoned dependency with a clean git state is rejected (extra file)", () => {
  const f = fixture();
  writeFileSync(join(f.root, "node_modules/zod/evil.js"), "process.exit(1)");
  assert.equal(
    code(() => verifyRuntime(f.root, f.manifest, f.pin)),
    "EXTRA_FILE",
  );
});

test("modified dependency or source file is rejected (hash mismatch)", () => {
  for (const rel of [
    "node_modules/zod/package.json",
    "src/cli.js",
    "scripts/windows/ONE-CLICK-ANY-DEVICE.ps1",
  ]) {
    const f = fixture();
    writeFileSync(join(f.root, rel), "tampered");
    assert.equal(
      code(() => verifyRuntime(f.root, f.manifest, f.pin)),
      "FILE_HASH_MISMATCH",
      rel,
    );
  }
});

// Windows cannot create symlinks without Developer Mode/admin (EPERM), but
// directory junctions need no privilege and lstat reports them as links.
const dirLink = (target, path) =>
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
const fileLinkOrSkip = (t, target, path) => {
  try {
    symlinkSync(target, path, "file");
    return true;
  } catch (e) {
    if (e.code !== "EPERM") throw e;
    t.diagnostic(`SKIPPED file-symlink case: ${e.code} (no symlink privilege)`);
    return false;
  }
};

test("missing listed file, symlink and hardlink-free non-regular entries are rejected", (t) => {
  let f = fixture();
  rmSync(join(f.root, "src/cli.js"));
  assert.equal(
    code(() => verifyRuntime(f.root, f.manifest, f.pin)),
    "MISSING_FILE",
  );
  f = fixture();
  rmSync(join(f.root, "node_modules/zod/package.json"));
  if (
    fileLinkOrSkip(
      t,
      join(f.root, "package.json"),
      join(f.root, "node_modules/zod/package.json"),
    )
  ) {
    assert.equal(
      code(() => verifyRuntime(f.root, f.manifest, f.pin)),
      "LINK_IN_RUNTIME",
    );
  }
  f = fixture();
  rmSync(join(f.root, "node_modules"), { recursive: true });
  dirLink(f.root, join(f.root, "node_modules"));
  assert.equal(
    code(() => verifyRuntime(f.root, f.manifest, f.pin)),
    "LINK_IN_RUNTIME",
  );
});

test("a manifest that is not the owner-approved one is rejected, even if self-consistent", () => {
  const f = fixture();
  writeFileSync(join(f.root, "src/cli.js"), "console.log('evil')\n");
  const forged = buildManifest(f.root, BINDING(NODE_SHA)); // attacker rebuilds a matching manifest
  assert.equal(
    code(() => verifyRuntime(f.root, forged, f.pin)),
    "MANIFEST_NOT_OWNER_APPROVED",
  );
  assert.equal(
    code(() => verifyRuntime(f.root, f.manifest, "not-a-hash")),
    "MANIFEST_PIN_INVALID",
  );
  assert.equal(
    code(() => verifyRuntime(f.root, { ...f.manifest, schema: "x" }, f.pin)),
    "MANIFEST_INVALID",
  );
});

test("manifest paths cannot escape or be absolute", () => {
  const f = fixture();
  const bad = structuredClone(f.manifest);
  bad.files["../outside"] = "b".repeat(64);
  assert.equal(
    code(() => verifyRuntime(f.root, bad, manifestSha256(bad))),
    "MANIFEST_INVALID",
  );
});

test("node.exe must hash to the owner-approved value", () => {
  const f = fixture();
  const nodeFile = join(f.root, "fake-node.exe");
  writeFileSync(nodeFile, "not node");
  assert.equal(
    code(() => verifyNode(nodeFile, f.manifest)),
    "NODE_NOT_OWNER_APPROVED",
  );
});

test("enrollment: wrong tenant/device/project, extra projects, wrong root, escaped or linked state are rejected", () => {
  const f = fixture();
  const store = mkdtempSync(join(tmpdir(), "kmj-store-"));
  mkdirSync(join(store, "state"));
  const good = () => ({
    id: "kmj-kmj-codebridge-desktop-5fvjmet",
    tenant: "tenant_1",
    stateDir: join(store, "state"),
    projects: [{ id: "kmj-codebridge", root: f.root }],
  });
  const ctx = { runtimeRoot: f.root, privateStore: store };
  assert.equal(verifyEnrollment(good(), f.manifest, ctx), true);
  const cases = [
    [
      (c) => {
        c.tenant = "other";
      },
      "ENROLLMENT_TENANT_MISMATCH",
    ],
    [
      (c) => {
        c.id = "kmj-homeoffice-calibration-pro";
      },
      "ENROLLMENT_DEVICE_MISMATCH",
    ],
    [
      (c) => {
        c.projects.push({ id: "kmj-calibration-pro", root: f.root });
      },
      "ENROLLMENT_NOT_SINGLE_PROJECT",
    ],
    [
      (c) => {
        c.projects[0].id = "kmj-calibration-pro";
      },
      "ENROLLMENT_PROJECT_MISMATCH",
    ],
    [
      (c) => {
        c.projects[0].root = tmpdir();
      },
      "ENROLLMENT_PROJECT_ROOT_MISMATCH",
    ],
    [
      (c) => {
        c.stateDir = tmpdir();
      },
      "ENROLLMENT_OUTSIDE_STORE",
    ],
    [
      (c) => {
        c.stateDir = "relative/state";
      },
      "ENROLLMENT_STATE_INVALID",
    ],
  ];
  for (const [mutate, expected] of cases) {
    const cfg = good();
    mutate(cfg);
    assert.equal(
      code(() => verifyEnrollment(cfg, f.manifest, ctx)),
      expected,
    );
  }
  const outside = mkdtempSync(join(tmpdir(), "kmj-outside-"));
  dirLink(outside, join(store, "linked"));
  const cfg = good();
  cfg.stateDir = join(store, "linked");
  assert.equal(
    code(() => verifyEnrollment(cfg, f.manifest, ctx)),
    "LINK_IN_ENROLLMENT_PATH",
  );
});

test("manifest binding must be well formed", () => {
  const f = fixture();
  assert.equal(
    code(() =>
      buildManifest(f.root, { ...BINDING(NODE_SHA), tenant: "bad tenant!" }),
    ),
    "MANIFEST_BINDING_INVALID",
  );
  assert.equal(
    code(() => buildManifest(f.root, { ...BINDING("zz") })),
    "MANIFEST_BINDING_INVALID",
  );
});

test("cli: build then verify round-trips; tamper and in-runtime output are refused", async () => {
  const { spawnSync } = await import("node:child_process");
  const cli = join(
    import.meta.dirname,
    "../scripts/windows/runtime-closure-cli.mjs",
  );
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("NODE_")),
  );
  const run = (...a) =>
    spawnSync(process.execPath, [cli, ...a], {
      encoding: "utf8",
      env: cleanEnv,
    });
  const f = fixture();
  const outDir = mkdtempSync(join(tmpdir(), "kmj-cli-out-"));
  const m = join(outDir, "manifest.json");
  const b = run(
    "build",
    "--root",
    f.root,
    "--tenant",
    "tenant_1",
    "--device",
    "kmj-kmj-codebridge-desktop-5fvjmet",
    "--project",
    "kmj-codebridge",
    "--node-exe",
    process.execPath,
    "--out",
    m,
  );
  assert.equal(b.status, 0, b.stdout);
  const pin = /MANIFEST_SHA256=([0-9a-f]{64})/.exec(b.stdout)[1];
  const v = run(
    "verify",
    "--root",
    f.root,
    "--manifest",
    m,
    "--pin",
    pin,
    "--node-exe",
    process.execPath,
  );
  assert.match(v.stdout, /RUNTIME_CLOSURE_OK/);
  assert.match(
    run(
      "build",
      "--root",
      f.root,
      "--tenant",
      "tenant_1",
      "--device",
      "d",
      "--project",
      "p",
      "--node-exe",
      process.execPath,
      "--out",
      join(f.root, "m.json"),
    ).stdout,
    /CLI_OUT_INSIDE_RUNTIME/,
  );
  const noNode = run("verify", "--root", f.root, "--manifest", m, "--pin", pin);
  assert.match(noNode.stdout, /CLI_USAGE/); // --node-exe cannot be omitted
  assert.equal(noNode.status, 2);
  const otherExe = run(
    "verify",
    "--root",
    f.root,
    "--manifest",
    m,
    "--pin",
    pin,
    "--node-exe",
    cli,
  );
  assert.match(otherExe.stdout, /NODE_NOT_RUNNING_EXE/); // must be the running interpreter
  writeFileSync(join(f.root, "src/cli.js"), "evil\n");
  const t = run(
    "verify",
    "--root",
    f.root,
    "--manifest",
    m,
    "--pin",
    pin,
    "--node-exe",
    process.execPath,
  );
  assert.equal(t.status, 2);
  assert.match(t.stdout, /FILE_HASH_MISMATCH/);
});

test("hardlinked files are rejected (build and verify)", () => {
  const f = fixture();
  linkSync(
    join(f.root, "src/cli.js"),
    join(mkdtempSync(join(tmpdir(), "kmj-hl-")), "alias.js"),
  );
  assert.equal(
    code(() => verifyRuntime(f.root, f.manifest, f.pin)),
    "HARDLINK_IN_RUNTIME",
  );
  assert.equal(
    code(() => buildManifest(f.root, BINDING(NODE_SHA))),
    "HARDLINK_IN_RUNTIME",
  );
});

test("hashing is bounded: oversize files and exhausted budgets are refused", () => {
  const f = fixture();
  const big = join(f.root, "src/big.bin");
  writeFileSync(big, "");
  truncateSync(big, MAX_FILE_BYTES + 1); // sparse, no real disk use
  assert.equal(
    code(() => sha256File(big)),
    "FILE_TOO_LARGE",
  );
  assert.equal(
    code(() => sha256File(join(f.root, "src/cli.js"), { left: 3 })),
    "RUNTIME_TOO_LARGE",
  );
});

test("ambient Node environment is rejected (NODE_OPTIONS/NODE_PATH, preload flags, parent node_modules)", () => {
  const f = fixture();
  const ok = (extra = {}) =>
    assertCleanNodeEnvironment(f.root, { env: {}, execArgv: [], ...extra });
  assert.equal(ok(), true);
  for (const k of ["NODE_OPTIONS", "NODE_PATH", "node_options"])
    assert.equal(
      code(() => ok({ env: { [k]: "x" } })),
      "AMBIENT_NODE_ENV",
    );
  assert.equal(
    code(() => ok({ execArgv: ["--require", "evil.js"] })),
    "AMBIENT_NODE_FLAGS",
  );
  // a node_modules in ANY parent of the runtime would be resolved by Node's upward walk
  const parent = mkdtempSync(join(tmpdir(), "kmj-parent-"));
  mkdirSync(join(parent, "node_modules"));
  mkdirSync(join(parent, "rt"));
  assert.equal(
    code(() =>
      assertCleanNodeEnvironment(join(parent, "rt"), { env: {}, execArgv: [] }),
    ),
    "AMBIENT_NODE_MODULES",
  );
  const home = mkdtempSync(join(tmpdir(), "kmj-home-"));
  mkdirSync(join(home, ".node_modules"));
  assert.equal(
    code(() => ok({ home })),
    "AMBIENT_NODE_MODULES",
  );
});
