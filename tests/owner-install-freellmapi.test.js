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

function runIsolatedSecurityCase(t, code) {
  if (process.platform !== "linux") {
    t.skip("needs Linux filesystem symlink semantics");
    return;
  }
  const result = spawnSync("python3", ["-I", "-B", "-c", code, file], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("preflight refuses dangling unit, install and environment symlinks", (t) => {
  runIsolatedSecurityCase(
    t,
    String.raw`
import importlib.util, pathlib, tempfile, sys
spec = importlib.util.spec_from_file_location("kmj_installer", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.os.geteuid = lambda: 0
m.shutil.which = lambda _: "/synthetic/tool"
m.node_version = lambda: (22, 0)
m.listeners = lambda: []
m.pwd.getpwnam = lambda _: (_ for _ in ()).throw(KeyError())
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    for attr, expected in (("UNIT", "UNIT_ALREADY_EXISTS"),
                           ("BASE", "INSTALL_DIR_ALREADY_EXISTS"),
                           ("ENV_DIR", "ENV_DIR_ALREADY_EXISTS")):
        m.UNIT = root / "unused-unit"
        m.BASE = root / "unused-base"
        m.ENV_DIR = root / "unused-env"
        link = root / ("dangling-" + attr)
        missing = root / ("missing-" + attr)
        link.symlink_to(missing)
        setattr(m, attr, link)
        assert not link.exists() and link.is_symlink()
        try:
            m.preflight()
        except ValueError as exc:
            assert str(exc) == expected, str(exc)
        else:
            raise AssertionError("DANGLING_LINK_NOT_REJECTED")
        assert link.is_symlink() and not missing.exists()
`,
  );
});

test("exclusive privileged write cannot follow a dangling link or overwrite a file", (t) => {
  runIsolatedSecurityCase(
    t,
    String.raw`
import importlib.util, pathlib, tempfile, stat, sys
spec = importlib.util.spec_from_file_location("kmj_installer", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    link, outside = root / "unit", root / "outside"
    link.symlink_to(outside)
    try:
        m.create_exclusive_file(link, "unit", 0o644)
    except FileExistsError:
        pass
    else:
        raise AssertionError("DANGLING_LINK_OVERWRITTEN")
    assert link.is_symlink() and not outside.exists()
    existing = root / "existing"
    existing.write_text("owner-data")
    try:
        m.create_exclusive_file(existing, "bad", 0o644)
    except FileExistsError:
        pass
    else:
        raise AssertionError("EXISTING_FILE_OVERWRITTEN")
    assert existing.read_text() == "owner-data"
    secret = root / "secret"
    m.create_exclusive_file(secret, "SYNTHETIC_TEST_ONLY", 0o600)
    assert stat.S_IMODE(secret.stat().st_mode) & 0o077 == 0
`,
  );
});

test("rollback preserves unrecognized and modified unit identities", (t) => {
  runIsolatedSecurityCase(
    t,
    String.raw`
import importlib.util, pathlib, tempfile, sys
spec = importlib.util.spec_from_file_location("kmj_installer", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    m.UNIT = root / "owner-unit"
    m.UNIT.write_text("owner-data")
    m.rollback()
    assert m.UNIT.read_text() == "owner-data"
    m.UNIT.unlink()
    m.UNIT_IDENTITY = None
    created = m.create_exclusive_file(m.UNIT, m.UNIT_TEXT, 0o644)
    m.UNIT_IDENTITY = (created.st_dev, created.st_ino)
    m.UNIT.write_text("modified-after-create")
    try:
        m.rollback()
    except ValueError as exc:
        assert str(exc) == "UNIT_CHANGED_PRESERVED", str(exc)
    else:
        raise AssertionError("FOREIGN_UNIT_ROLLBACK_ALLOWED")
    assert m.UNIT.read_text() == "modified-after-create"
`,
  );
});
