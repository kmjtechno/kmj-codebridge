import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const runner = readFileSync(
  new URL(
    "../examples/main-platform-staging/d32/owner-runner.sh",
    import.meta.url,
  ),
  "utf8",
);
const match = runner.match(
  /python3 - <<'PY' \|\| deny SYSTEMD_EFFECTIVE_UNIT\n([\s\S]*?)\nPY/,
);

test(
  "effective systemd unit preflight rejects drop-ins, stale cache, and changed manager state",
  { skip: process.platform === "win32" },
  () => {
    assert.ok(match, "real embedded systemd preflight must be present");
    // Execute the actual embedded Python with a mocked systemctl result.
    // No root, network, systemd service or staging files are touched.
    const harness = [
      "import sys, subprocess",
      "from types import SimpleNamespace",
      "from unittest.mock import patch",
      "case = sys.argv[1]",
      "lines = ['LoadState=loaded',",
      "         'FragmentPath=/etc/systemd/system/kmj-main-platform-staging-deploy.service',",
      "         'DropInPaths=', 'NeedDaemonReload=no']",
      "if case == 'unloaded': lines[0] = 'LoadState=not-found'",
      "if case == 'wrong_fragment': lines[1] = 'FragmentPath=/tmp/unsafe.service'",
      "if case == 'dropin': lines[2] = 'DropInPaths=/etc/systemd/system/override.conf'",
      "if case == 'stale_cache': lines[3] = 'NeedDaemonReload=yes'",
      "if case == 'missing_property': lines.pop()",
      "if case == 'duplicate_property': lines.append('LoadState=loaded')",
      "if case == 'malformed_property': lines[2] = 'DropInPaths'",
      "def fake_run(argv, **kwargs):",
      "    assert argv == ['/usr/bin/systemctl', 'show',",
      "                    'kmj-main-platform-staging-deploy.service', '--no-pager',",
      "                    '--property=LoadState,FragmentPath,DropInPaths,NeedDaemonReload']",
      "    assert kwargs['check'] is True and kwargs['timeout'] == 15",
      "    if case == 'systemctl_failed':",
      "        raise subprocess.CalledProcessError(1, argv)",
      "    return SimpleNamespace(stdout='\\n'.join(lines) + '\\n')",
      "with patch.object(subprocess, 'run', fake_run):",
      "    try:",
      "        exec(compile(sys.stdin.read(), 'embedded-systemd-preflight', 'exec'),",
      "             {'__name__': '__main__'})",
      "    except (ValueError, OSError, subprocess.CalledProcessError,",
      "            subprocess.TimeoutExpired):",
      "        sys.exit(2)",
    ].join("\n");
    for (const name of [
      "valid",
      "unloaded",
      "wrong_fragment",
      "dropin",
      "stale_cache",
      "missing_property",
      "duplicate_property",
      "malformed_property",
      "systemctl_failed",
    ]) {
      const result = spawnSync("python3", ["-c", harness, name], {
        input: match[1],
        encoding: "utf8",
        timeout: 10000,
      });
      assert.equal(
        result.status,
        name === "valid" ? 0 : 2,
        name + ": " + result.stderr,
      );
    }
  },
);
