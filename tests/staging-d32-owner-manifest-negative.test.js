import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const runnerPath = new URL(
  "../examples/main-platform-staging/d32/owner-runner.sh",
  import.meta.url,
);
const runner = readFileSync(runnerPath, "utf8");
const match = runner.match(
  /python3 - "\$approved" "\$prior" <<'PY' \|\| deny OWNER_MANIFEST_OR_INSTALL\n([\s\S]*?)\nPY/,
);

// Execute the actual embedded approval validator, not a rewritten copy. All
// paths are redirected into a disposable local fixture; no root, systemd,
// deployment, network, or production paths are touched.
test(
  "offline approval validator rejects malformed, stale, or unsafe manifests",
  {
    skip: process.platform === "win32",
  },
  () => {
    assert.ok(match, "embedded offline approval validator must exist");
    const harness = String.raw`
import hashlib, json, os, pathlib, stat, sys, tempfile
from types import SimpleNamespace
from unittest.mock import patch

validator = sys.stdin.read()
approved = 'd32df111e3a8dae75c8d3321a80f07424c23fe77'
prior = '9d15e14e39564ffb1e66085a483feb8331f9718f'
fixed = 'ExecStart=/usr/bin/bash /usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh'
cases = ['valid', 'missing_manifest', 'malformed_json', 'missing_key', 'extra_key',
         'wrong_approved_sha', 'wrong_current_sha', 'wrong_production',
         'false_backup', 'false_rollback', 'false_storage', 'false_zero_cost',
         'runner_hash_drift', 'unit_hash_drift', 'unit_execstart_missing',
         'manifest_symlink', 'manifest_hardlink', 'writable_parent',
         'nonroot_runner', 'schema_drift']
results = {}
for case in cases:
    with tempfile.TemporaryDirectory(prefix='kmj-staging-approval-test-') as tmp:
        base = pathlib.Path(tmp)
        r = base / 'libexec' / 'owner-runner.sh'
        u = base / 'systemd' / 'owner-staging.service'
        m = base / 'approval' / 'main-platform-staging-approval.json'
        for p in (r, u, m):
            p.parent.mkdir(parents=True, exist_ok=True)
            p.parent.chmod(0o755)
        r.write_bytes(b'root-owned fixed runner test bytes\n')
        u.write_bytes(('[Service]\n' + fixed + '\n').encode())
        manifest = {
            'schema': 'kmj.main-platform.staging-approval.v1',
            'approvedSha': approved,
            'expectedCurrentSha': prior,
            'expectedProductionRelease': 'platform-8070dad72c55',
            'runnerSha256': hashlib.sha256(r.read_bytes()).hexdigest(),
            'unitSha256': hashlib.sha256(u.read_bytes()).hexdigest(),
            'backupVerified': True, 'rollbackVerified': True,
            'storageVerified': True, 'zeroAdditionalCostVerified': True,
        }
        if case == 'missing_key': del manifest['backupVerified']
        if case == 'extra_key': manifest['unexpected'] = True
        if case == 'wrong_approved_sha': manifest['approvedSha'] = prior
        if case == 'wrong_current_sha': manifest['expectedCurrentSha'] = approved
        if case == 'wrong_production': manifest['expectedProductionRelease'] = 'other'
        if case == 'false_backup': manifest['backupVerified'] = False
        if case == 'false_rollback': manifest['rollbackVerified'] = False
        if case == 'false_storage': manifest['storageVerified'] = False
        if case == 'false_zero_cost': manifest['zeroAdditionalCostVerified'] = False
        if case == 'runner_hash_drift': manifest['runnerSha256'] = '0' * 64
        if case == 'unit_hash_drift': manifest['unitSha256'] = '0' * 64
        if case == 'schema_drift': manifest['schema'] = 'other'
        if case == 'unit_execstart_missing':
            u.write_bytes(b'[Service]\nExecStart=/bin/false\n')
            manifest['unitSha256'] = hashlib.sha256(u.read_bytes()).hexdigest()
        m.write_text(json.dumps(manifest))
        if case == 'malformed_json': m.write_text('{ invalid')
        if case == 'missing_manifest': m.unlink()
        if case == 'manifest_symlink':
            target = base / 'other-manifest.json'
            target.write_text(json.dumps(manifest))
            m.unlink()
            m.symlink_to(target)
        if case == 'manifest_hardlink': os.link(m, base / 'manifest-hardlink')
        if case == 'writable_parent': m.parent.chmod(0o777)
        script = validator.replace(
            'Path("/usr/local/libexec/kmj-codebridge/kmj-main-platform-staging-deploy.sh")',
            'Path(' + repr(str(r)) + ')').replace(
            'Path("/etc/systemd/system/kmj-main-platform-staging-deploy.service")',
            'Path(' + repr(str(u)) + ')').replace(
            'Path("/etc/kmj-codebridge/main-platform-staging-approval.json")',
            'Path(' + repr(str(m)) + ')')
        if script == validator or '/etc/kmj-codebridge/main-platform-staging-approval.json' in script:
            raise AssertionError('fixture path replacement failed')
        original_lstat = pathlib.Path.lstat
        def fake_lstat(path):
            info = original_lstat(path)
            # Simulate protected root-owned system paths without privileges.
            # Keep actual fixture modes, links, sizes and hardlink counts.
            inside = path == base or base in path.parents
            mode = info.st_mode if inside else (stat.S_IFDIR | 0o755)
            uid = 1000 if case == 'nonroot_runner' and path == r else 0
            return SimpleNamespace(st_uid=uid, st_mode=mode,
                                   st_nlink=info.st_nlink, st_size=info.st_size)
        original_argv = sys.argv
        sys.argv = ['validator', approved, prior]
        try:
            with patch.object(pathlib.Path, 'lstat', fake_lstat):
                try:
                    exec(compile(script, 'real-embedded-approval-validator', 'exec'),
                         {'__name__': '__main__'})
                    passed = True
                except (ValueError, OSError, json.JSONDecodeError, KeyError, TypeError):
                    passed = False
        finally:
            sys.argv = original_argv
        results[case] = passed
print(json.dumps(results, sort_keys=True))
`;
    const result = spawnSync("python3", ["-c", harness], {
      input: match[1],
      encoding: "utf8",
      timeout: 30000,
    });
    assert.equal(result.status, 0, result.stderr);
    const outcomes = JSON.parse(result.stdout);
    assert.equal(outcomes.valid, true, "valid exact-SHA manifest should pass");
    for (const [name, accepted] of Object.entries(outcomes)) {
      if (name !== "valid")
        assert.equal(accepted, false, name + " must fail closed");
    }
    assert.equal(Object.keys(outcomes).length, 20);
  },
);
