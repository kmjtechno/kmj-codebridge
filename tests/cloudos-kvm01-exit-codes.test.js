import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(
  root,
  "scripts/production/retire-google-cloudos-kvm01-canary.py",
);

test(
  "retirement CLI returns 0 for passed dry-run, 2 for runtime error and 130 for interrupt",
  { skip: process.platform === "win32" },
  () => {
    const python = [
      "import contextlib, importlib.util, io, sys",
      "from unittest.mock import patch",
      "spec = importlib.util.spec_from_file_location('canary', sys.argv[1])",
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "with patch.object(module, 'main', return_value=0):",
      "    stderr = io.StringIO()",
      "    with contextlib.redirect_stderr(stderr):",
      "        assert module.main_entry() == 0",
      "    assert stderr.getvalue() == '', stderr.getvalue()",
      "with patch.object(module, 'main', side_effect=RuntimeError('PREFLIGHT_BLOCKED')):",
      "    stderr = io.StringIO()",
      "    with contextlib.redirect_stderr(stderr):",
      "        assert module.main_entry() == 2",
      "    assert 'RETIREMENT_ERROR=RuntimeError:PREFLIGHT_BLOCKED' in stderr.getvalue()",
      "with patch.object(module, 'main', side_effect=KeyboardInterrupt):",
      "    stderr = io.StringIO()",
      "    with contextlib.redirect_stderr(stderr):",
      "        assert module.main_entry() == 130",
      "    assert 'RETIREMENT_INTERRUPTED' in stderr.getvalue()",
      "print('CANARY_EXIT_STATUS_TEST=PASS')",
    ].join("\n");
    const output = execFileSync("python3", ["-B", "-c", python, script], {
      cwd: root,
      timeout: 10000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /CANARY_EXIT_STATUS_TEST=PASS/);
  },
);
