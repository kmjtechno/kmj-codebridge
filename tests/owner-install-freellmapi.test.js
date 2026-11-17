import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "scripts/production/owner_install_freellmapi_loopback_20261117.py";
const script = fs.readFileSync(file, "utf8");

test("script compiles", () => {
  const result = spawnSync("python3", [
    "-I",
    "-B",
    "-c",
    "import ast,sys;ast.parse(open(sys.argv[1]).read())",
    file,
  ]);
  assert.equal(result.status, 0);
});

test("pins the exact upstream commit and the adapter port", () => {
  assert.match(script, /COMMIT = "fd327a57bc4157b22d483007b522c2152c54ae9a"/);
  assert.match(
    script,
    /REPO = "https:\/\/github\.com\/tashfeenahmed\/freellmapi"/,
  );
  assert.match(script, /HOST = "127\.0\.0\.1"/);
  assert.match(script, /PORT = 31415/);
  assert.match(script, /PINNED_COMMIT_MISMATCH/);
});

test("dry run is the default and apply needs the explicit confirmation", () => {
  assert.match(script, /INSTALL=DRY_RUN_UNCHANGED/);
  assert.match(
    script,
    /args in \(\[\], \["--apply", "--confirm-install-freellmapi"\]\)/,
  );
});

test("refuses to overwrite anything and rolls the unit back on failure", () => {
  for (const code of [
    "UNIT_ALREADY_EXISTS",
    "INSTALL_DIR_ALREADY_EXISTS",
    "ENV_DIR_ALREADY_EXISTS",
    "PORT_IN_USE",
    "USER_ALREADY_EXISTS",
    "NOT_LOOPBACK_ONLY",
  ]) {
    assert.match(script, new RegExp(code));
  }
  assert.match(script, /rollback\(\)/);
});

test("runs unprivileged, hardened, and never prints or stores secrets elsewhere", () => {
  for (const line of [
    "User={USER}",
    "NoNewPrivileges=true",
    "ProtectSystem=strict",
    "Environment=HOST={HOST}",
    "Environment=PORT={PORT}",
  ]) {
    assert.ok(script.includes(line), line);
  }
  assert.match(script, /ENV_FILE\.chmod\(0o600\)/);
  assert.doesNotMatch(script, /print\([^)]*ENCRYPTION_KEY/);
  assert.doesNotMatch(script, /CODEBRIDGE_FREELLMAPI_KEY\s*=/);
  assert.doesNotMatch(script, /SELF_UPDATE|WATCHTOWER/);
});

test("non-root run is blocked before any change", (t) => {
  if (process.platform !== "linux" || process.getuid() === 0) {
    t.skip("needs a non-root Linux user");
    return;
  }
  const result = spawnSync("python3", ["-I", "-B", file], {
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /BLOCKED=ROOT_REQUIRED/);
});
