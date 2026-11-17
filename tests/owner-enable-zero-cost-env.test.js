import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const file = "scripts/production/owner_enable_zero_cost_env_20261117.py";
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

test("dry run default; writes need an explicit mode plus the no-active-jobs flag; key only from hidden prompt", () => {
  assert.match(script, /ENV=DRY_RUN_UNCHANGED/);
  assert.match(script, /"--apply": "apply", "--rotate-key": "rotate"/);
  assert.match(script, /args\[2\] == "--confirm-no-active-jobs"/);
  assert.match(script, /getpass\.getpass\(/);
  assert.doesNotMatch(script, /print\([^)]*\bkey\b/);
  assert.doesNotMatch(script, /sys\.argv[^\n]*key/i);
});

test("touches only the agent env file and one restart; nothing else", () => {
  for (const bad of [
    "gateway-stage",
    "stable-update",
    "nginx",
    "daemon-reload",
  ]) {
    assert.ok(!code.includes(bad), bad);
  }
  assert.match(script, /UNIT = "kmj-codebridge-kmj-main-platform\.service"/);
  assert.match(script, /O_CREAT \| os\.O_EXCL \| os\.O_NOFOLLOW/);
  assert.match(script, /os\.replace\(tmp, ENV_FILE\)/);
});

test("OpenRouter check is HTTPS openrouter.ai only with no redirects", () => {
  assert.match(script, /https:\/\/openrouter\.ai\/api\/v1\/key/);
  assert.match(script, /return None/);
});

function isolatedPythonCase(t, code) {
  if (process.platform !== "linux") {
    t.skip("requires Linux semantics");
    return;
  }
  const result = spawnSync("python3", ["-I", "-B", "-c", code, file], {
    encoding: "utf8",
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

const LOAD = String.raw`
import importlib.util, json, pathlib, tempfile, sys, time, os
spec = importlib.util.spec_from_file_location("kmj_env", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

test("chain_models accepts only a fresh all-openrouter :free pin and snapshot", (t) => {
  isolatedPythonCase(
    t,
    LOAD +
      String.raw`
with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    m.PINS_DIR, m.SNAPSHOT_DIR = root / "pins", root / "snap"
    m.PINS_DIR.mkdir(); m.SNAPSHOT_DIR.mkdir()
    now = int(time.time() * 1000)
    ids = ["google/a-it:free", "nvidia/b:free"]
    def write(pin_models=ids, plat="openrouter", age=1000, snap_ids=ids, chain="auto:c"):
        (m.PINS_DIR / "route-binding-c.json").write_text(json.dumps(
            {"version": 1, "chain": "auto:c", "models": pin_models, "sha256": "x"}))
        (m.SNAPSHOT_DIR / "c.json").write_text(json.dumps(
            {"version": 1, "chain": chain, "observedAtEpochMs": now - age,
             "members": [{"platform": plat, "modelId": i} for i in snap_ids]}))
    write()
    assert sorted(m.chain_models("auto:c", now)) == sorted(ids)
    for kwargs, code in (
        ({"pin_models": ["google/a-it"]}, "PIN_MODELS_NOT_ALL_FREE"),
        ({"plat": "kilo"}, "SNAPSHOT_NOT_ALL_OPENROUTER"),
        ({"age": 500000}, "SNAPSHOT_STALE"),
        ({"snap_ids": ["google/a-it:free"]}, "SNAPSHOT_DIFFERS_FROM_PIN"),
        ({"chain": "auto:other"}, "SNAPSHOT_CHAIN_MISMATCH"),
    ):
        write(**kwargs)
        try:
            m.chain_models("auto:c", now)
        except ValueError as exc:
            assert str(exc) == code, (kwargs, str(exc))
        else:
            raise AssertionError("ACCEPTED_" + code)
    try:
        m.chain_models("auto:../x", now)
    except ValueError as exc:
        assert str(exc) == "CHAIN_NAME_REJECTED"
    else:
        raise AssertionError("PATH_CHAIN_ACCEPTED")
`,
  );
});

test("build_env sets one approved chain, adds three vars, refuses duplicates", (t) => {
  isolatedPythonCase(
    t,
    LOAD +
      String.raw`
lines = ["CODEBRIDGE_FREELLMAPI_KEY=SYNTHETIC_TEST_ONLY_AAAA",
         "CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS="]
out = m.build_env(lines, "SYNTHETIC_OR_KEY_BBBBBBBB", "auto:c").decode().splitlines()
assert out.count("CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS=auto:c") == 1
assert "CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS=" not in out
assert "CODEBRIDGE_FREELLMAPI_KEY=SYNTHETIC_TEST_ONLY_AAAA" in out
assert any(l.startswith("CODEBRIDGE_OPENROUTER_KEY=") for l in out)
assert "CODEBRIDGE_FREELLMAPI_PINS_DIR=/etc/kmj-freellmapi-pins" in out
for extra in ("CODEBRIDGE_OPENROUTER_KEY=old", "CODEBRIDGE_FREELLMAPI_PINS_DIR=/x"):
    try:
        m.build_env(lines + [extra], "SYNTHETIC_OR_KEY_BBBBBBBB", "auto:c")
    except ValueError as exc:
        assert str(exc) == "ENV_ALREADY_HAS_VERIFIER_KEYS"
    else:
        raise AssertionError("DUPLICATE_ALLOWED")
try:
    m.build_env(["OTHER=1"], "SYNTHETIC_OR_KEY_BBBBBBBB", "auto:c")
except ValueError as exc:
    assert str(exc) == "FREELLMAPI_KEY_LINE_MISSING"
else:
    raise AssertionError("MISSING_KEY_LINE_ALLOWED")
`,
  );
});

test("replace_env is atomic, 0600, and refuses a pre-existing temp symlink", (t) => {
  isolatedPythonCase(
    t,
    LOAD +
      String.raw`
import stat
with tempfile.TemporaryDirectory() as temp:
    root = pathlib.Path(temp)
    m.protected = lambda p: True
    m.ENV_FILE = root / "codebridge.env"
    m.ENV_FILE.write_text("old")
    m.replace_env(b"new\n")
    assert m.ENV_FILE.read_text() == "new\n"
    assert stat.S_IMODE(m.ENV_FILE.stat().st_mode) & 0o077 == 0
    outside = root / "outside"
    (root / "codebridge.env.tmp").symlink_to(outside)
    try:
        m.replace_env(b"bad")
    except FileExistsError:
        pass
    else:
        raise AssertionError("SYMLINK_TMP_FOLLOWED")
    assert not outside.exists() and m.ENV_FILE.read_text() == "new\n"
`,
  );
});

test("key_blockers refuses zero or exhausted limits, budgets and any spend", (t) => {
  isolatedPythonCase(
    t,
    LOAD +
      String.raw`
ok = {"usage": 0, "usage_daily": 0, "usage_weekly": 0, "usage_monthly": 0, "byok_usage": 0}
assert m.key_blockers(dict(ok, limit_remaining=None)) == []
assert m.key_blockers(dict(ok)) == []
assert m.key_blockers(dict(ok, limit_remaining=5.0, effective_budget={"remaining_usd": 2})) == []
assert m.key_blockers(dict(ok, limit_remaining=0)) == ["KEY_LIMIT_EXHAUSTED_SET_NO_CREDIT_LIMIT"]
assert m.key_blockers(dict(ok, effective_budget={"remaining_usd": 0})) == ["BUDGET_BLOCKING"]
assert "SPEND_NOT_ZERO_usage" in m.key_blockers(dict(ok, usage=0.01))
assert "SPEND_NOT_ZERO_byok_usage" in m.key_blockers({k: v for k, v in ok.items() if k != "byok_usage"})
`,
  );
});

test("rotate_env replaces only the OpenRouter key line and needs the enabled chain", (t) => {
  isolatedPythonCase(
    t,
    LOAD +
      String.raw`
base = ["CODEBRIDGE_FREELLMAPI_KEY=SYNTHETIC_TEST_ONLY_AAAA",
        "CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS=auto:c",
        "CODEBRIDGE_OPENROUTER_KEY=OLD_SYNTHETIC",
        "CODEBRIDGE_FREELLMAPI_PINS_DIR=/etc/kmj-freellmapi-pins",
        "CODEBRIDGE_FREELLMAPI_SNAPSHOT_DIR=/var/lib/kmj-freellmapi-chain"]
out = m.rotate_env(base, "NEW_SYNTHETIC_KEY_1234", "auto:c").decode().splitlines()
assert out == [base[0], base[1], "CODEBRIDGE_OPENROUTER_KEY=NEW_SYNTHETIC_KEY_1234", base[3], base[4]]
for bad, code in (
    (base[:2] + base[3:], "ENV_HAS_NO_SINGLE_OPENROUTER_KEY_LINE"),
    (base + ["CODEBRIDGE_OPENROUTER_KEY=DUP"], "ENV_HAS_NO_SINGLE_OPENROUTER_KEY_LINE"),
    ([base[0], "CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS="] + base[2:], "ENV_NOT_ENABLED_FOR_CHAIN"),
):
    try:
        m.rotate_env(bad, "NEW_SYNTHETIC_KEY_1234", "auto:c")
    except ValueError as exc:
        assert str(exc) == code, str(exc)
    else:
        raise AssertionError("ACCEPTED_" + code)
`,
  );
});
