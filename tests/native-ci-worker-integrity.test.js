import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const name of ["ci-main-platform-pr.sh", "ci-main-platform-pr337.sh"]) {
  const source = fs.readFileSync(path.join(root, "scripts", name), "utf8");
  test(`${name} executes an immutable trusted worker outside PR ownership`, () => {
    assert.doesNotMatch(source, /cp "\$worker" "\$job\/worker.sh"/);
    assert.match(source, /\/bin\/bash "\$worker" "\$job\/src"/);
    assert.match(source, /-p ProtectSystem=strict/);
    assert.match(source, /-p CapabilityBoundingSet= \\/);
    assert.match(source, /CI_TRUSTED_WORKER_INVALID/);
  });
  test(`${name} rejects writable, linked and missing worker files`, (t) => {
    if (process.platform === "win32" || process.getuid?.() !== 0)
      return t.skip("root-owned POSIX metadata fixture");
    const helper = source.match(/check_trusted_worker\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(helper);
    const temp = fs.mkdtempSync("/opt/kmj-worker-integrity-");
    try {
      const file = path.join(temp, "worker.sh");
      fs.writeFileSync(file, "#!/bin/bash\n");
      fs.chmodSync(file, 0o755);
      const run = (target) =>
        spawnSync(
          "bash",
          [
            "-ec",
            'worker="$1";\n' + helper + "\ncheck_trusted_worker",
            "fixture",
            target,
          ],
          { encoding: "utf8", timeout: 5000 },
        );
      assert.equal(run(file).status, 0);
      fs.chmodSync(temp, 0o777);
      assert.equal(run(file).status, 3);
      fs.chmodSync(temp, 0o700);
      const directoryLink = path.join("/opt", path.basename(temp) + "-link");
      fs.symlinkSync(temp, directoryLink);
      try {
        assert.equal(run(path.join(directoryLink, "worker.sh")).status, 3);
      } finally {
        fs.unlinkSync(directoryLink);
      }
      fs.chmodSync(file, 0o777);
      assert.equal(run(file).status, 3);
      fs.chmodSync(file, 0o4755);
      assert.equal(run(file).status, 3);
      fs.chmodSync(file, 0o755);
      try {
        fs.chownSync(file, 65534, 65534);
        assert.equal(run(file).status, 3);
        fs.chownSync(file, 0, 0);
      } catch (error) {
        if (!["EINVAL", "EPERM"].includes(error.code)) throw error;
        t.diagnostic("Foreign UID fixture unavailable in this user namespace");
      }
      fs.symlinkSync(file, path.join(temp, "link"));
      assert.equal(run(path.join(temp, "link")).status, 3);
      fs.linkSync(file, path.join(temp, "hardlink"));
      assert.equal(run(file).status, 3);
      assert.equal(run(path.join(temp, "missing")).status, 3);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
