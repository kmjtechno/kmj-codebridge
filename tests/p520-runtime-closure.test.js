import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
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
