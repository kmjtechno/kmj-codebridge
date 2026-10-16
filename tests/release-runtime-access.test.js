import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReleaseStore } from "../src/release-store.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-runtime-access-"));
  fs.chmodSync(root, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const manifest = {
    schema: 1,
    product: "KMJ CodeBridge",
    channel: "beta",
    sequence: 1,
    version: "0.3.2",
    revision: "a".repeat(40),
    archive: "https://example.com/runtime.tar.gz",
    sha256: "b".repeat(64),
    bytes: 100,
    nodeMajor: 24,
    publishedAt: "2026-10-15T00:00:00Z",
    keyId: "beta",
  };
  const store = new ReleaseStore({
    installRoot: path.join(root, "install"),
    stateDir: path.join(root, "state"),
  });
  const staged = store.staging(manifest);
  fs.mkdirSync(path.join(staged.staging, "src"), { mode: 0o700 });
  fs.writeFileSync(
    path.join(staged.staging, "package.json"),
    JSON.stringify({ name: "@kmjtechno/codebridge", version: "0.3.2" }),
    { mode: 0o600 },
  );
  fs.writeFileSync(path.join(staged.staging, "src/cli.js"), "export {};\n", {
    mode: 0o600,
  });
  return { root, manifest, store, staged };
}

test(
  "finalized runtime is readable by an unprivileged agent under umask 077",
  { skip: process.platform === "win32" },
  (t) => {
    const mask = process.umask(0o077);
    try {
      const { root, manifest, store, staged } = fixture(t);
      assert.equal(fs.statSync(staged.staging).mode & 0o777, 0o700);
      const release = store.finalize(manifest, staged.staging);
      for (const relative of [
        "install",
        "install/releases",
        path.relative(root, release.target),
        path.relative(root, path.join(release.target, "src")),
      ]) {
        const mode = fs.statSync(path.join(root, relative)).mode;
        assert.equal(
          mode & 0o005,
          0o005,
          relative + " must be traversable by the agent",
        );
        assert.equal(
          mode & 0o022,
          0,
          relative + " must not be writable by the agent",
        );
      }
      for (const name of [
        "package.json",
        "src/cli.js",
        ".codebridge-release.json",
      ]) {
        const mode = fs.statSync(path.join(release.target, name)).mode;
        assert.equal(
          mode & 0o004,
          0o004,
          name + " must be readable by the agent",
        );
        assert.equal(mode & 0o022, 0);
      }
      assert.equal(fs.statSync(store.stateDir).mode & 0o077, 0);
    } finally {
      process.umask(mask);
    }
  },
);

for (const kind of ["symlink", "hardlink"]) {
  test(
    `finalize rejects an escaping ${kind} without changing its target`,
    { skip: process.platform === "win32" },
    (t) => {
      const { root, manifest, store, staged } = fixture(t);
      const outside = path.join(root, "private-key");
      fs.writeFileSync(outside, "private", { mode: 0o600 });
      const link = path.join(staged.staging, "escape");
      if (kind === "symlink") fs.symlinkSync(path.relative(staged.staging, outside), link);
      else fs.linkSync(outside, link);
      assert.throws(
        () => store.finalize(manifest, staged.staging),
        /UPDATE_STAGED_RUNTIME_INVALID/,
      );
      assert.equal(fs.statSync(outside).mode & 0o777, 0o600);
    },
  );
}

test(
  "finalize preserves internal npm executable links without making the runtime group writable",
  { skip: process.platform === "win32" },
  (t) => {
    const { manifest, store, staged } = fixture(t);
    const bin = path.join(staged.staging, "node_modules/.bin");
    fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
    const script = path.join(staged.staging, "node_modules/tool.js");
    fs.writeFileSync(script, "#!/usr/bin/env node\n", { mode: 0o700 });
    fs.symlinkSync("../tool.js", path.join(bin, "tool"));
    const release = store.finalize(manifest, staged.staging);
    assert.equal(
      fs.readlinkSync(path.join(release.target, "node_modules/.bin/tool")),
      "../tool.js",
    );
    assert.equal(
      fs.statSync(path.join(release.target, "node_modules/.bin/tool")).mode &
        0o777,
      0o755,
    );
  },
);

test(
  "finalize rejects absolute internal links that would break after rename",
  { skip: process.platform === "win32" },
  (t) => {
    const { manifest, store, staged } = fixture(t);
    fs.symlinkSync(
      path.join(staged.staging, "src/cli.js"),
      path.join(staged.staging, "absolute-cli"),
    );
    assert.throws(
      () => store.finalize(manifest, staged.staging),
      /UPDATE_STAGED_RUNTIME_INVALID/,
    );
  },
);

test(
  "finalize strips writable and special permission bits from the complete runtime",
  { skip: process.platform === "win32" },
  (t) => {
    const { manifest, store, staged } = fixture(t);
    fs.chmodSync(path.join(staged.staging, "src"), 0o7777);
    fs.chmodSync(path.join(staged.staging, "src/cli.js"), 0o6777);
    const release = store.finalize(manifest, staged.staging);
    assert.equal(
      fs.statSync(path.join(release.target, "src")).mode & 0o7777,
      0o755,
    );
    assert.equal(
      fs.statSync(path.join(release.target, "src/cli.js")).mode & 0o7777,
      0o755,
    );
  },
);
