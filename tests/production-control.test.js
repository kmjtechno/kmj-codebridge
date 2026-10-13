import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const activate = fs.readFileSync(
  "scripts/production/activate-main-platform-approved.py",
  "utf8",
);
const install = fs.readFileSync(
  "scripts/production/install-main-platform-control.sh",
  "utf8",
);
const unit = fs.readFileSync(
  "scripts/production/kmj-main-platform-production-release.service",
  "utf8",
);

test("production control is a fixed, non-shell, operator-approved service", () => {
  assert.match(unit, /User=root/);
  assert.match(unit, /Type=oneshot/);
  assert.match(
    unit,
    /ExecStart=\/usr\/local\/libexec\/kmj-codebridge\/activate-main-platform-approved\.py/,
  );
  assert.match(unit, /NoNewPrivileges=yes/);
  assert.match(unit, /ProtectSystem=full/);
  assert.doesNotMatch(
    unit,
    /\/bin\/(?:sh|bash)|EnvironmentFile=|ExecStartPre=.+\$|\$\{/,
  );
  assert.match(install, /PRODUCTION_CONTROL_INSTALLED_NO_DEPLOY=1/);
  assert.doesNotMatch(
    install,
    /systemctl start kmj-main-platform-production-release/,
  );
  assert.match(activate, /NO_CALLER_ARGUMENTS_ALLOWED/);
  assert.doesNotMatch(
    activate,
    /shell=True|os\.system\(|eval\(|subprocess\.Popen\(/,
  );
});

test("release controller fails closed on unreviewed release or missing backup", () => {
  for (const marker of [
    "PRODUCTION_POINTER_OUTSIDE_RELEASES",
    "EXPECTED_CURRENT_RELEASE_MISMATCH",
    "BACKUP_CHECKSUM_MISMATCH",
    "CANDIDATE_SHA_MISMATCH",
    "CANDIDATE_DIRTY",
    "CANDIDATE_ARTIFACT_MISSING",
    "MAIN_PLATFORM_ROLLBACK_VERIFIED",
    "MAIN_PLATFORM_ACTIVATION_PASS",
    "approvedSha",
    "rollbackVerified",
    "backupVerified",
  ])
    assert.ok(activate.includes(marker), marker);
  assert.match(activate, /os\.replace\(temporary, CURRENT\)/);
  assert.match(activate, /switch_to\(old_target, "rollback"\)/);
  assert.match(activate, /health_check\(\)/);
});

test(
  "release Python and installer scripts parse without running production code",
  { skip: process.platform === "win32" },
  () => {
    const py = spawnSync(
      "python3",
      [
        "-c",
        "import ast,sys; ast.parse(open(sys.argv[1],encoding='utf8').read())",
        "scripts/production/activate-main-platform-approved.py",
      ],
      { encoding: "utf8" },
    );
    assert.equal(py.status, 0, py.stderr);
    const sh = spawnSync(
      "bash",
      ["-n", "scripts/production/install-main-platform-control.sh"],
      { encoding: "utf8" },
    );
    assert.equal(sh.status, 0, sh.stderr);
  },
);

test("supervisor sees only the KMJ production home under a read-only bind", () => {
  const dropin = fs.readFileSync(
    "scripts/production/kmj-codebridge-supervisor-prod-readonly.conf",
    "utf8",
  );
  assert.match(dropin, /ProtectHome=tmpfs/);
  assert.match(dropin, /^BindReadOnlyPaths=\/home\/kmjprod$/m);
  assert.doesNotMatch(dropin, /ProtectHome=(?:false|no)|BindPaths=/);
  assert.doesNotMatch(dropin, /\/home\/\*|\/root\b/);
  assert.match(install, /kmj-codebridge-supervisor-prod-readonly\.conf/);
  assert.match(install, /20-main-platform-production-readonly\.conf/);
  assert.doesNotMatch(install, /systemctl restart kmj-codebridge-supervisor/);
});

test("legacy Main Platform supervisor bootstrap is fixed, root-gated and preserves enrollment", () => {
  const bootstrap = fs.readFileSync(
    "scripts/production/bootstrap-existing-supervisor.sh",
    "utf8",
  );
  assert.match(install, /bootstrap-existing-supervisor\.sh/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_REQUIRES_ROOT/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_WRONG_HOST/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_AGENT_EXEC_MISMATCH/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_RUNTIME_PATH_UNAPPROVED/);
  assert.match(bootstrap, /property=WorkingDirectory/);
  assert.match(bootstrap, /kmj-codebridge-main-platform-stage\/\[a-f0-9\]/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_STAGE_SHA_MISMATCH/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_NODE_TARGET_UNSAFE/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_NODE_OWNER_UNSAFE/);
  assert.match(bootstrap, /property=ExecStart/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_RUNTIME_TREE_WRITABLE/);
  assert.match(bootstrap, /SUPERVISOR_BOOTSTRAP_CONFIG_PERMISSIONS_UNSAFE/);
  assert.match(bootstrap, /SocketMode=0600/);
  assert.match(bootstrap, /User=root/);
  assert.match(bootstrap, /BindReadOnlyPaths=\/home\/kmjprod/);
  assert.match(bootstrap, /NoNewPrivileges=true/);
  assert.match(bootstrap, /RestrictAddressFamilies=AF_UNIX/);
  assert.match(bootstrap, /SUPERVISOR_SOCKET_ACTIVE=1/);
  assert.doesNotMatch(
    bootstrap,
    /curl |wget |git clone|git pull|eval |bash -c/,
  );
  assert.doesNotMatch(
    bootstrap,
    /systemctl restart .*AGENT|enroll-device|systemctl start kmj-main-platform-production-release/,
  );
});

test(
  "legacy supervisor socket bootstrap parses on Linux",
  { skip: process.platform === "win32" },
  () => {
    const run = spawnSync(
      "bash",
      ["-n", "scripts/production/bootstrap-existing-supervisor.sh"],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
  },
);
