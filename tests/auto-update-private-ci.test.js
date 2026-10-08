import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = fs.readFileSync("scripts/auto-update-development.sh", "utf8");
const expected = "8ebbb6f1999309875b6f6b0c6d25c21847fff3ff";

test("current updater schedules fixed owner CI once and defers busy or untrusted state", (t) => {
  if (process.platform === "win32") return t.skip("POSIX guarded updater");
  const match = script.match(
    /retry_fixed_private_pr322_ci\(\) \{[\s\S]*?<<'PY'\n([\s\S]*?)\nPY\n\}/,
  );
  assert.ok(match, "fixed CURRENT owner CI scheduler must exist");
  assert.match(
    script,
    /if \[\[ "\$current" == "\$remote" \]\]; then[\s\S]*?retry_fixed_private_pr322_ci/,
  );
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "kmj-owner-scheduler-"),
  );
  const base = path.join(directory, "base"),
    runtime = path.join(directory, "runtime"),
    units = path.join(directory, "units"),
    repo = path.join(directory, "repo");
  const evidence = path.join(base, "evidence"),
    calls = path.join(directory, "calls.jsonl");
  const worker = path.join(runtime, "scripts/ci-main-platform-pr-worker.sh");
  const marker = path.join(evidence, "pr322-auto-update-scheduled.json");
  try {
    for (const dir of [evidence, path.dirname(worker), units, repo])
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(worker, "trusted-worker-v1", { mode: 0o644 });
    for (const script of [
      "ci-main-platform-pr-fixed.sh",
      "ci-main-platform-pr.sh",
    ])
      fs.writeFileSync(
        path.join(runtime, "scripts", script),
        "trusted-preparer",
        { mode: 0o644 },
      );
    fs.writeFileSync(path.join(base, ".ci.lock"), "", { mode: 0o600 });
    fs.writeFileSync(
      path.join(units, "kmj-codebridge-private-pr322-ci.service"),
      `Description=KMJ CodeBridge private PR322 CI\nExecStart=/bin/bash ${runtime}/scripts/ci-main-platform-pr-fixed.sh\n`,
      { mode: 0o644 },
    );
    const body = match[1]
      .replaceAll("/var/lib/kmj-codebridge-ci", base)
      .replaceAll("/opt/kmj-codebridge-agent", runtime)
      .replaceAll("/etc/systemd/system", units)
      .replaceAll("/srv/kmj-codebridge-projects/kmj-main-platform", repo);
    const prelude = `
import os, stat, json, subprocess
from types import SimpleNamespace
real_lstat, real_fstat = os.lstat, os.fstat
# Root identity is mocked because hosted CI runs as an unprivileged user.
def root_stat(value):
    data = list(value); data[4] = 0; return os.stat_result(data)
os.lstat = lambda value: root_stat(real_lstat(value))
os.fstat = lambda value: root_stat(real_fstat(value))
def stub_run(args, **kwargs):
    with open(os.environ['TEST_CALLS'], 'a') as f: f.write(json.dumps(args) + '\\n')
    if args[0] == '/usr/bin/git':
        return SimpleNamespace(returncode=0, stdout=(os.environ.get('TEST_CONTROL_SHA', 'b' * 40) if args[-1] == 'HEAD' else os.environ.get('TEST_SOURCE', '${expected}')) + '\\n')
    if args[0] == '/usr/bin/flock':
        return SimpleNamespace(returncode=int(os.environ.get('TEST_LOCK_BUSY', '0')), stdout='')
    if args[0] == '/usr/bin/systemctl' and args[1] == 'show':
        unit = args[2]
        state = os.environ.get('TEST_337_STATE' if 'pr337' in unit else 'TEST_322_STATE', 'inactive')
        return SimpleNamespace(returncode=0, stdout='LoadState=loaded\\nActiveState=' + state + '\\nFragmentPath=' + os.environ.get('TEST_FRAGMENT', '${units}/' + unit) + '\\nDropInPaths=' + os.environ.get('TEST_DROPINS', '') + '\\n')
    if args == ['/usr/bin/systemctl', 'start', '--no-block', 'kmj-codebridge-private-pr322-ci.service']:
        return SimpleNamespace(returncode=int(os.environ.get('TEST_START_FAIL', '0')), stdout='')
    raise AssertionError('Unexpected scheduler command: ' + repr(args))
subprocess.run = stub_run
`;
    const run = (env = {}) => {
      fs.writeFileSync(calls, "");
      const result = spawnSync("python3", ["-c", prelude + body], {
        encoding: "utf8",
        timeout: 5000,
        env: { ...process.env, TEST_CALLS: calls, ...env },
      });
      assert.equal(result.status, 0, result.stderr);
      const commands = fs
        .readFileSync(calls, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse);
      return {
        result,
        starts: commands.filter(
          (command) =>
            command[0] === "/usr/bin/systemctl" && command[1] === "start",
        ),
      };
    };
    for (const env of [
      { TEST_337_STATE: "active" },
      { TEST_322_STATE: "activating" },
      { TEST_LOCK_BUSY: "1" },
      { TEST_DROPINS: "/private/override.conf" },
      { TEST_FRAGMENT: "/private/replaced-unit.service" },
      { TEST_SOURCE: "a".repeat(40) },
      { TEST_START_FAIL: "1" },
    ]) {
      const { starts, result } = run(env);
      assert.equal(starts.length, env.TEST_START_FAIL ? 1 : 0);
      assert.equal(fs.existsSync(marker), false);
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /private|override|trusted-worker/,
      );
    }
    assert.equal(run().starts.length, 1);
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600);
    const first = fs.readFileSync(marker, "utf8");
    assert.equal(JSON.parse(first).source_sha, expected);
    assert.equal(run().starts.length, 0);
    assert.equal(fs.readFileSync(marker, "utf8"), first);
    fs.writeFileSync(worker, "trusted-worker-v2");
    assert.equal(run().starts.length, 1);
    assert.notEqual(fs.readFileSync(marker, "utf8"), first);
    for (const script of [
      "ci-main-platform-pr-fixed.sh",
      "ci-main-platform-pr.sh",
    ]) {
      fs.appendFileSync(path.join(runtime, "scripts", script), "-changed");
      assert.equal(run().starts.length, 1);
      assert.equal(run().starts.length, 0);
    }
    assert.equal(run({ TEST_CONTROL_SHA: "c".repeat(40) }).starts.length, 1);
    assert.equal(run({ TEST_CONTROL_SHA: "c".repeat(40) }).starts.length, 0);
    fs.chmodSync(marker, 0o644);
    assert.equal(run().starts.length, 0);
    fs.chmodSync(marker, 0o600);
    fs.unlinkSync(marker);
    fs.symlinkSync(worker, marker);
    assert.equal(run().starts.length, 0);
    fs.unlinkSync(marker);
    fs.linkSync(worker, marker);
    assert.equal(run().starts.length, 0);
    fs.unlinkSync(marker);
    fs.writeFileSync(marker, '{"source_sha":"private-secret"}', {
      mode: 0o600,
    });
    const invalid = run();
    assert.equal(invalid.starts.length, 0);
    assert.doesNotMatch(
      invalid.result.stdout + invalid.result.stderr,
      /private-secret/,
    );
    fs.unlinkSync(marker);
    fs.chmodSync(evidence, 0o777);
    assert.equal(run().starts.length, 0);
    fs.chmodSync(evidence, 0o700);
    fs.chmodSync(worker, 0o666);
    assert.equal(run().starts.length, 0);
    fs.chmodSync(worker, 0o644);
    const unitfile = path.join(
      units,
      "kmj-codebridge-private-pr322-ci.service",
    );
    const trustedUnit = fs.readFileSync(unitfile, "utf8");
    for (const extra of [
      "ExecStart=/bin/false",
      "  ExecStartPre = /bin/false",
      "  ExecStop=/bin/false",
      "ExecReload=/bin/false",
      "ExecStopPost=/bin/false",
      "ExecCondition=/bin/false",
    ]) {
      fs.writeFileSync(unitfile, trustedUnit + extra + "\n");
      assert.equal(run().starts.length, 0);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
