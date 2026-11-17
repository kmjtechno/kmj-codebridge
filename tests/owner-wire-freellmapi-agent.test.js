import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "scripts/production/owner_wire_freellmapi_agent_20261117.py";
const script = fs.readFileSync(file, "utf8");
const open3 = script.indexOf('"""');
const code = script.slice(script.indexOf('"""', open3 + 3) + 3); // skip docstring

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

test("dry run is default; apply needs the explicit no-active-jobs flag", () => {
  assert.match(script, /WIRING=DRY_RUN_UNCHANGED/);
  assert.match(
    script,
    /args in \(\[\], \["--apply", "--confirm-no-active-jobs"\]\)/,
  );
});

test("key comes only from a hidden prompt and is never printed or logged", () => {
  assert.match(script, /getpass\.getpass\(/);
  assert.doesNotMatch(script, /sys\.argv\[[^\]]*\]\s*\)?\s*#?.*key/i);
  assert.doesNotMatch(script, /print\([^)]*\bkey\b/);
  assert.match(script, /os\\.O_CREAT \\| os\\.O_EXCL \\| os\\.O_NOFOLLOW/);
  assert.match(script, /write_new_file\\(\\s*ENV_FILE,[\\s\\S]*?0o600/);
});

test("only an EnvironmentFile drop-in on the agent; nothing else is touched", () => {
  assert.match(script, /EnvironmentFile=\{ENV_FILE\}/);
  for (const bad of [
    "gateway-stage",
    "stable-update",
    "nginx",
    "stable/current",
  ]) {
    assert.ok(!code.includes(bad), bad);
  }
  assert.match(script, /DROPIN_ALREADY_EXISTS/);
  assert.match(script, /ENV_FILE_ALREADY_EXISTS/);
});

test("validates before writing and rolls back only after a write", () => {
  assert.ok(
    script.indexOf("def collect") < script.indexOf("def write_and_restart"),
  );
  assert.match(script, /CHAIN_NOT_ADVERTISED/);
  assert.match(script, /key, chosen = collect\(\)/);
  assert.match(script, /WIRING=FAILED_ROLLED_BACK/);
});

test("never claims generation is enabled", () => {
  assert.match(script, /FREELLMAPI_ZERO_COST_NOT_ATTESTED/);
});

function isolatedPythonCase(t, code) {
  if (process.platform !== "linux") {
    t.skip("requires Linux symlink and O_NOFOLLOW semantics");
    return;
  }
  const result = spawnSync("python3", ["-I", "-B", "-c", code, file], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("dangling agent env, dropin, and directory symlinks fail before writes", (t) => {
  isolatedPythonCase(
    t,
    String.raw`
import importlib.util, pathlib, tempfile, types, sys
spec = importlib.util.spec_from_file_location("kmj_wire", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.os.geteuid = lambda: 0
m.cmd = lambda *args, **kw: types.SimpleNamespace(stdout="active", returncode=0)
m.protected_parent = lambda p: not p.is_symlink()
with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    for field, code in (
        ("DROPIN", "DROPIN_ALREADY_EXISTS"),
        ("ENV_FILE", "ENV_FILE_ALREADY_EXISTS"),
        ("DROPIN_DIR", "DROPIN_DIR_UNSAFE"),
    ):
        m.DROPIN = root / "uncreated-dropin"
        m.ENV_FILE = root / "uncreated-env"
        m.DROPIN_DIR = root / "uncreated-dir"
        link = root / ("link-" + field)
        outside = root / ("missing-" + field)
        link.symlink_to(outside)
        setattr(m, field, link)
        try:
            m.preflight()
        except ValueError as exc:
            assert str(exc) == code, (field, str(exc))
        else:
            raise AssertionError("DANGLING_LINK_ALLOWED_" + field)
        assert link.is_symlink() and not outside.exists()
`,
  );
});

test("exclusive file creation refuses symlinks and existing files", (t) => {
  isolatedPythonCase(
    t,
    String.raw`
import importlib.util, pathlib, stat, tempfile, sys
spec = importlib.util.spec_from_file_location("kmj_wire", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    outside, link = root / "outside", root / "env"
    link.symlink_to(outside)
    try:
        m.write_new_file(link, "BAD", 0o600)
    except FileExistsError:
        pass
    else:
        raise AssertionError("SYMLINK_WRITE_NOT_BLOCKED")
    assert not outside.exists()
    existing = root / "owner"
    existing.write_text("preserved")
    try:
        m.write_new_file(existing, "BAD", 0o600)
    except FileExistsError:
        pass
    else:
        raise AssertionError("OWNER_FILE_OVERWRITTEN")
    assert existing.read_text() == "preserved"
    created = root / "created"
    m.write_new_file(created, "SYNTHETIC_TEST_ONLY", 0o600)
    assert stat.S_IMODE(created.stat().st_mode) & 0o077 == 0
`,
  );
});

test("rollback never removes foreign or modified files or restarts agent before write", (t) => {
  isolatedPythonCase(
    t,
    String.raw`
import importlib.util, pathlib, tempfile, sys
spec = importlib.util.spec_from_file_location("kmj_wire", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
calls = []
m.cmd = lambda *args, **kw: calls.append(args)
with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    m.DROPIN, m.ENV_FILE = root / "dropin", root / "env"
    m.DROPIN.write_text("owner-dropin")
    m.ENV_FILE.write_text("owner-env")
    m.rollback()
    assert m.DROPIN.read_text() == "owner-dropin"
    assert m.ENV_FILE.read_text() == "owner-env"
    assert not calls
    m.DROPIN.unlink()
    m.ENV_FILE.unlink()
    m.write_new_file(m.ENV_FILE, "SYNTHETIC_TEST_ONLY", 0o600)
    m.ENV_FILE.write_text("owner-modification")
    try:
        m.rollback()
    except ValueError as exc:
        assert str(exc) == "OWNED_FILE_CHANGED_PRESERVED", str(exc)
    else:
        raise AssertionError("MODIFIED_FILE_ROLLBACK_ALLOWED")
    assert m.ENV_FILE.read_text() == "owner-modification"
    assert not calls
    m.CREATED.clear()
    m.ENV_FILE.unlink()
    m.write_new_file(m.ENV_FILE, "SYNTHETIC_TEST_ONLY", 0o600)
    m.rollback()
    assert not m.ENV_FILE.exists() and not calls
    m.write_new_file(m.DROPIN, m.DROPIN_TEXT, 0o644)
    m.rollback()
    assert not m.DROPIN.exists()
    assert calls == [("systemctl", "daemon-reload"), ("systemctl", "restart", m.UNIT)]
`,
  );
});
