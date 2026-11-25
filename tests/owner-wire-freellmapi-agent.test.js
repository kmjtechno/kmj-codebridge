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
  assert.match(script, /os\.O_CREAT \| os\.O_EXCL \| os\.O_NOFOLLOW/);
  assert.match(script, /write_new_file\(\s*ENV_FILE,[\s\S]*?0o600/);
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

test("targets the live elite Main Platform project agent unit", () => {
  assert.match(script, /UNIT = "kmj-codebridge-kmj-main-platform\.service"/);
  assert.ok(!script.includes("kmj-codebridge-agent.service"));
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

test("onboarding accepts only named profiles and refuses malformed catalogs", (t) => {
  isolatedPythonCase(
    t,
    String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("kmj_wire", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
aliases = ["smart", "fast", "reliability", "SMART", "balanced", "price"]
rows = [{"id": "auto:" + name} for name in aliases]
rows += [{"id": "auto:code"}, {"id": "auto:or-free"}, {"id": "auto:a..b"}]
assert m.chain_names({"data": rows}) == ["auto:code", "auto:or-free"]
for payload in (None, {"data": [{}]}, {"data": [{"id": 1}]},
                {"data": [{"id": "auto:code"}, {"id": "auto:code"}]}):
    try:
        m.chain_names(payload)
    except ValueError as exc:
        assert str(exc) == "INVALID_CATALOG"
    else:
        raise AssertionError("MALFORMED_CATALOG_ACCEPTED")
try:
    m.RejectRedirect().redirect_request(None, None, 302, "", {}, "https://example.invalid")
except ValueError as exc:
    assert str(exc) == "ROUTER_REDIRECT_DENIED"
else:
    raise AssertionError("REDIRECT_ALLOWED")
`,
  );
});

test("onboarding aborts if hidden terminal input is unavailable", (t) => {
  isolatedPythonCase(
    t,
    String.raw`
import importlib.util, sys, warnings
spec = importlib.util.spec_from_file_location("kmj_wire", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.getpass.getpass = lambda *_: warnings.warn("unavailable", m.getpass.GetPassWarning)
m.models = lambda *_: (_ for _ in ()).throw(AssertionError("NETWORK_REACHED"))
try:
    m.collect()
except ValueError as exc:
    assert str(exc) == "PRIVATE_INPUT_UNAVAILABLE"
else:
    raise AssertionError("UNSAFE_INPUT_ACCEPTED")
`,
  );
});

test("Elite development staging has separate credentials and never restarts either agent", (t) => {
  isolatedPythonCase(
    t,
    String.raw`
import importlib.util, pathlib, tempfile, types, sys
spec = importlib.util.spec_from_file_location("kmj_wire", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
original = m.ENV_FILE
m.select_elite_dev()
assert m.UNIT == "kmj-codebridge-dev.service"
assert m.ENV_FILE != original
assert m.ENV_FILE.name == "codebridge-dev.env"
assert m.DROPIN.parent.name == "kmj-codebridge-dev.service.d"
m.elite_dev_identity = lambda: None
m.preflight = lambda: None
m.protected_parent = lambda p: p.is_dir() and not p.is_symlink()
calls = []
m.cmd = lambda *args, **kw: calls.append(args)
with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    m.ENV_FILE = root / "env"
    m.DROPIN_DIR = root / "dev.service.d"
    m.DROPIN = m.DROPIN_DIR / "fabric.conf"
    m.DROPIN_TEXT = "[Service]\nEnvironmentFile=" + str(m.ENV_FILE) + "\n"
    m.stage_elite_dev("SYNTHETIC_ONLY_12345", ["auto:or-free"])
    assert m.ENV_FILE.is_file() and m.DROPIN.is_file()
    assert m.ENV_FILE.stat().st_mode & 0o077 == 0
    assert not calls
    m.rollback(restart=False)
    assert not m.ENV_FILE.exists() and not m.DROPIN.exists()
    assert not calls
`,
  );
});

test("Elite development identity denies a wrong service account", (t) => {
  isolatedPythonCase(
    t,
    String.raw`
import importlib.util, types, sys
spec = importlib.util.spec_from_file_location("kmj_wire", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
m.select_elite_dev()
m.os.geteuid = lambda: 0
m.socket.gethostname = lambda: "KMJ-elite"
base = "LoadState=loaded\nActiveState=active\nGroup=kmjdev\nFragmentPath=/etc/systemd/system/kmj-codebridge-dev.service\nNeedDaemonReload=no\nMainPID=123\n"
m.cmd = lambda *args, **kw: types.SimpleNamespace(stdout=base + "User=root\n")
try:
    m.elite_dev_identity()
except ValueError as exc:
    assert str(exc) == "DEV_AGENT_EFFECTIVE_IDENTITY_INVALID"
else:
    raise AssertionError("WRONG_SERVICE_IDENTITY_ALLOWED")
m.cmd = lambda *args, **kw: types.SimpleNamespace(stdout=base + "User=kmjdev\n")
m.elite_dev_identity()
`,
  );
});
