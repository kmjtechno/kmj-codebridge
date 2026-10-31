import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const installer = fs.readFileSync(
  new URL(
    "../scripts/production/install-development-nonroot-probe.py",
    import.meta.url,
  ),
  "utf8",
);
const helper = fs.readFileSync(
  new URL("../scripts/production/kmj-codebridge-dev-probe.py", import.meta.url),
);
const unit = fs.readFileSync(
  new URL(
    "../scripts/production/kmj-codebridge-development-ci.service",
    import.meta.url,
  ),
);

test("operator installer is pinned to the exact merged fixed-root probe assets", () => {
  for (const data of [helper, unit]) {
    const sha = createHash("sha256").update(data).digest("hex");
    assert.ok(installer.includes(sha), `Missing exact SHA256 pin ${sha}`);
  }
  assert.match(installer, /os\.geteuid\(\) != 0/);
  assert.match(installer, /EXPECTED_HOST = "kmj-elite"/);
  assert.match(installer, /--install-and-test/);
  assert.match(installer, /O_EXCL/);
  assert.match(installer, /O_NOFOLLOW/);
  assert.match(installer, /"productionChanged": False/);
  assert.match(installer, /"autonomousCodingLive": False/);
  assert.match(installer, /os\.setuid\(identity\.pw_uid\)/);
});

test("restricted dev service has neither root user nor persistent start-on-boot", () => {
  const txt = unit.toString();
  assert.match(txt, /^User=kmjdevci$/m);
  assert.match(txt, /^Group=kmjdevci$/m);
  assert.match(txt, /^ProtectSystem=strict$/m);
  assert.match(txt, /^PrivateNetwork=yes$/m);
  assert.match(txt, /^NoNewPrivileges=yes$/m);
  assert.doesNotMatch(txt, /^WantedBy=/m);
  assert.doesNotMatch(installer, /systemctl["', ]+enable/);
  assert.doesNotMatch(installer, /systemctl["', ]+restart/);
  assert.doesNotMatch(installer, /curl\s*\|\s*(?:sudo\s+)?bash/);
});

test("operator effective-unit admission is full, strict, and fails closed", () => {
  assert.match(installer, /EXPECTED_UNIT_PROPERTIES =/);
  assert.match(
    installer,
    /return effective_unit_diagnostic\(\)\["status"\] == "MATCH"/,
  );
  assert.match(installer, /"unitMismatchKeys": \[\]/);
  assert.match(
    installer,
    /report\["unitMismatchKeys"\] = diagnostic\["mismatchKeys"\]/,
  );
  assert.match(installer, /meta\.st_mode & 0o7022/);
  // Execute the real Python verifier with the subprocess boundary mocked.
  // No systemctl invocation, service activation, or host mutations occur.
  const script = String.raw`
import importlib.util
import sys
import types
from types import SimpleNamespace
from unittest.mock import patch

# This imported installer targets Linux, but its pure admission function is
# tested on both CI platforms; stub only unavailable POSIX imports on Windows.
if sys.platform == "win32":
    sys.modules["grp"] = types.ModuleType("grp")
    sys.modules["pwd"] = types.ModuleType("pwd")

spec = importlib.util.spec_from_file_location("kmj_dev_installer_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

expected = module.EXPECTED_UNIT_PROPERTIES
assert len(expected) == 16
assert expected["User"] == "kmjdevci"
assert expected["ActiveState"] == "inactive"
assert expected["CapabilityBoundingSet"] == ""
assert expected["AmbientCapabilities"] == ""
assert expected["EnvironmentFiles"] == ""
assert expected["DropInPaths"] == ""

calls = []
def check(lines, status=0):
    def fake_command(argv):
        calls.append(argv)
        return SimpleNamespace(returncode=status, stdout="\n".join(lines))
    with patch.object(module, "command", side_effect=fake_command):
        return module.verify_effective_unit()

baseline = [key + "=" + value for key, value in expected.items()]
assert check(baseline)
for key, value in expected.items():
    mutated = dict(expected)
    mutated[key] = value + "unsafe"
    assert not check([name + "=" + val for name, val in mutated.items()]), key

assert not check(baseline[:-1])
assert not check(baseline + ["User=root"])
assert not check(baseline + ["InjectedProperty=secret"])
assert not check(baseline, status=1)
assert not check(["User=" + ("x" * 9000)])

# Diagnostic must reveal ONLY allowlisted mismatched property NAMES, never
# actual systemd values, credentials, or incomplete/malformed evidence.
def inspect(lines, status=0):
    def fake_command(argv):
        calls.append(argv)
        return SimpleNamespace(returncode=status, stdout="\n".join(lines))
    with patch.object(module, "command", side_effect=fake_command):
        return module.effective_unit_diagnostic()

assert inspect(baseline) == {"status": "MATCH", "mismatchKeys": []}
# Exactly one ordinary LF terminator is allowed. CRLF and non-LF separators
# must never be silently normalized into an apparently trusted systemd unit.
assert check(baseline + [""])
assert inspect(baseline + [""]) == {"status": "MATCH", "mismatchKeys": []}
assert not check([line + "\r" for line in baseline])
assert inspect([line + "\r" for line in baseline]) == {"status": "MALFORMED", "mismatchKeys": []}
assert not check(baseline[:-1] + [baseline[-1] + "\u2028"])
assert inspect(baseline[:-1] + [baseline[-1] + "\u2028"]) == {"status": "MISMATCH", "mismatchKeys": ["ReadWritePaths"]}
assert not check(baseline + ["", ""])
changed = dict(expected)
changed["ActiveState"] = "failed"
changed["User"] = "root"
diagnostic = inspect([k + "=" + v for k, v in changed.items()])
assert diagnostic == {"status": "MISMATCH", "mismatchKeys": ["ActiveState", "User"]}
assert "root" not in str(diagnostic) and "failed" not in str(diagnostic)
assert inspect(baseline[:-1]) == {"status": "MALFORMED", "mismatchKeys": []}
assert inspect(baseline + ["User=root"]) == {"status": "MALFORMED", "mismatchKeys": []}
assert inspect(baseline, status=1) == {"status": "READ_FAILED", "mismatchKeys": []}
# subprocess.run(text=True) can raise UnicodeDecodeError on malformed
# systemctl bytes. Treat decoding failure as READ_FAILED, not traceback.
decode_error = UnicodeDecodeError("utf-8", bytes([0xff]), 0, 1, "invalid byte")
with patch.object(module.subprocess, "run", side_effect=decode_error):
    assert module.command(["/usr/bin/systemctl", "show", module.UNIT]) is None
    assert module.effective_unit_diagnostic() == {"status": "READ_FAILED", "mismatchKeys": []}
assert inspect(["User=" + ("x" * 9000)]) == {"status": "MALFORMED", "mismatchKeys": []}
# The host-pinned --diagnose-only CLI must never mutate root files,
# reload systemd, start a service, create users, or write a receipt.
def forbidden(*args, **kwargs):
    raise AssertionError("DIAGNOSTIC_MUTATION_ATTEMPT")

for status, keys, expected_exit in [
    ("MATCH", [], 0),
    ("MISMATCH", ["User"], 3),
    ("MALFORMED", [], 3),
    ("READ_FAILED", [], 3),
]:
    with patch.object(module.socket, "gethostname", return_value="kmj-elite"), \
         patch.object(module.os, "geteuid", side_effect=forbidden, create=True), \
         patch.object(module, "effective_unit_diagnostic", return_value={"status": status, "mismatchKeys": keys}), \
         patch.object(module, "account", side_effect=forbidden), \
         patch.object(module, "stage_root_file", side_effect=forbidden), \
         patch.object(module, "receipt", side_effect=forbidden), \
         patch.object(module, "command", side_effect=forbidden), \
         patch.object(sys, "argv", ["probe", "--diagnose-only"]), \
         patch("builtins.print") as printed:
        assert module.main() == expected_exit
        output = [call.args[0] for call in printed.call_args_list]
        assert "KMJ_CB_DEV_UNIT_DIAGNOSTIC=" + status in output
        assert "KMJ_CB_DEV_UNIT_MISMATCH_KEYS=" + ",".join(keys) in output
        assert "KMJ_CB_DEV_UNIT_NO_MUTATION=YES" in output
        assert all("root" not in line.lower() for line in output)

with patch.object(module.socket, "gethostname", return_value="untrusted-host"), \
     patch.object(module, "effective_unit_diagnostic", side_effect=forbidden), \
     patch.object(sys, "argv", ["probe", "--diagnose-only"]), \
     patch("builtins.print") as printed:
    assert module.main() == 2
    assert printed.call_args_list[0].args[0] == "KMJ_CB_DEV_UNIT_DIAGNOSTIC=DENIED_HOST"

for argv in calls:
    assert argv[:3] == ["/usr/bin/systemctl", "show", module.UNIT]
    assert argv[3] == "--no-pager"
    assert len(argv) == 4 + (len(expected) * 2)
    assert argv[4::2] == ["-p"] * len(expected)
    assert argv[5::2] == list(expected)
print("EFFECTIVE_UNIT_PARITY=PASS")
`;
  const python = process.platform === "win32" ? "python" : "python3";
  const result = spawnSync(
    python,
    [
      // Isolated Python ignores PYTHONOPTIMIZE/PYTHONPATH from the host.
      // Security assertions must never be silently disabled by environment.
      "-I",
      "-c",
      script,
      fileURLToPath(
        new URL(
          "../scripts/production/install-development-nonroot-probe.py",
          import.meta.url,
        ),
      ),
    ],
    // Windows CI may take >10s to launch isolated Python under concurrent
    // tests. Keep a finite timeout and fail-closed assertions, not a skip.
    { encoding: "utf8", timeout: 60000 },
  );
  // This is a required security admission test. A missing interpreter,
  // timeout or spawn failure must FAIL CI, not produce a green skipped test.
  assert.ifError(result.error);
  assert.equal(result.signal, null, "Python verifier was terminated");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /EFFECTIVE_UNIT_PARITY=PASS/);
});
