import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const posix = process.platform !== "win32";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cb-uninstall-"));
  const dirs = {
    CODEBRIDGE_INSTALL_DIR: path.join(root, "opt-agent"),
    CODEBRIDGE_CONFIG_DIR: path.join(root, "etc-config"),
    CODEBRIDGE_STATE_DIR: path.join(root, "var-state"),
    CODEBRIDGE_NODE_DIR: path.join(root, "opt-node"),
    CODEBRIDGE_UNIT_DIR: path.join(root, "units"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d);
  fs.writeFileSync(
    path.join(dirs.CODEBRIDGE_UNIT_DIR, "kmj-codebridge-agent.service"),
    "x",
  );
  fs.writeFileSync(path.join(dirs.CODEBRIDGE_CONFIG_DIR, "agent.json"), "{}");
  const log = path.join(root, "systemctl.log");
  const fake = path.join(root, "fake-systemctl");
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
  return {
    root,
    dirs,
    log,
    env: {
      ...process.env,
      ...dirs,
      CODEBRIDGE_SYSTEMCTL: fake,
      CODEBRIDGE_UNINSTALL_TEST: "1",
    },
  };
}
const run = (env, args) =>
  spawnSync("bash", ["scripts/uninstall-vps.sh", ...args], {
    env,
    encoding: "utf8",
  });

test("uninstaller is shell-valid", (t) => {
  if (!posix) return t.skip("bash only");
  assert.equal(spawnSync("bash", ["-n", "scripts/uninstall-vps.sh"]).status, 0);
});

test("default is dry-run and changes nothing", (t) => {
  if (!posix) return t.skip("bash only");
  const f = fixture();
  const r = run(f.env, []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /UNINSTALL=DRY-RUN/);
  assert.ok(fs.existsSync(f.dirs.CODEBRIDGE_INSTALL_DIR));
  assert.ok(
    fs.existsSync(
      path.join(f.dirs.CODEBRIDGE_UNIT_DIR, "kmj-codebridge-agent.service"),
    ),
  );
  assert.equal(fs.existsSync(f.log), false);
});

test("apply removes code and units but preserves config and state", (t) => {
  if (!posix) return t.skip("bash only");
  const f = fixture();
  const r = run(f.env, ["--apply"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(f.dirs.CODEBRIDGE_INSTALL_DIR), false);
  assert.equal(fs.existsSync(f.dirs.CODEBRIDGE_NODE_DIR), false);
  assert.equal(
    fs.existsSync(
      path.join(f.dirs.CODEBRIDGE_UNIT_DIR, "kmj-codebridge-agent.service"),
    ),
    false,
  );
  assert.ok(fs.existsSync(f.dirs.CODEBRIDGE_CONFIG_DIR));
  assert.ok(fs.existsSync(f.dirs.CODEBRIDGE_STATE_DIR));
  assert.match(
    fs.readFileSync(f.log, "utf8"),
    /disable --now kmj-codebridge-agent.service/,
  );
});

test("--purge-data also deletes config and state", (t) => {
  if (!posix) return t.skip("bash only");
  const f = fixture();
  assert.equal(run(f.env, ["--apply", "--purge-data"]).status, 0);
  assert.equal(fs.existsSync(f.dirs.CODEBRIDGE_CONFIG_DIR), false);
  assert.equal(fs.existsSync(f.dirs.CODEBRIDGE_STATE_DIR), false);
});

test("unsafe or relative paths and unknown options are refused", (t) => {
  if (!posix) return t.skip("bash only");
  const f = fixture();
  for (const bad of ["/", "/etc", "/usr", "relative/dir", "/tmp/../etc"]) {
    const r = run({ ...f.env, CODEBRIDGE_INSTALL_DIR: bad }, ["--apply"]);
    assert.equal(r.status, 3, bad);
    assert.match(r.stderr, /UNSAFE_PATH/);
  }
  assert.equal(run(f.env, ["--nuke"]).status, 2);
});
