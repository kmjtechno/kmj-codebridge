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

test("operator effective-unit admission is full, strict, and fails closed", (t) => {
  assert.match(installer, /EXPECTED_UNIT_PROPERTIES =/);
  assert.match(installer, /return props == EXPECTED_UNIT_PROPERTIES/);
  assert.match(installer, /meta\.st_mode & 0o7022/);
  // Execute the real Python verifier with the subprocess boundary mocked.
  // No systemctl invocation, service activation, or host mutations occur.
  const script = String.raw`
import importlib.util
import sys
from types import SimpleNamespace
from unittest.mock import patch

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
      "-c",
      script,
      fileURLToPath(
        new URL(
          "../scripts/production/install-development-nonroot-probe.py",
          import.meta.url,
        ),
      ),
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  if (result.error?.code === "ENOENT") {
    t.skip("Python interpreter unavailable on this runner");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /EFFECTIVE_UNIT_PARITY=PASS/);
});
