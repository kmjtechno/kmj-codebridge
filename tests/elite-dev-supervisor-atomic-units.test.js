import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "scripts/production/owner_install_elite_dev_supervisor.py";
const PYTHON = process.platform !== "win32";

// Hermetic test only: redirect the fixed unit directory to a disposable temp
// directory and simulate root fstat ownership. Never import/call main(), never
// invoke systemctl, and never touch an actual host unit or signing credential.
const SCRIPT = [
  "import importlib.util, pathlib, tempfile, os, types",
  "from unittest import mock",
  "spec=importlib.util.spec_from_file_location('installer', 'scripts/production/owner_install_elite_dev_supervisor.py')",
  "mod=importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(mod)",
  "with tempfile.TemporaryDirectory(prefix='kmj-atomic-unit-test-') as temp:",
  "    mod.UNIT_DIR=pathlib.Path(temp)",
  "    mod.root_parents=lambda target: None",
  "    original_fstat=os.fstat",
  "    def root_fstat(fd):",
  "        s=original_fstat(fd)",
  "        return types.SimpleNamespace(st_uid=0,st_mode=s.st_mode,st_nlink=s.st_nlink,st_size=s.st_size,st_dev=s.st_dev,st_ino=s.st_ino)",
  "    with mock.patch.object(mod.os, 'fstat', side_effect=root_fstat):",
  "        p=mod.UNIT_DIR/mod.SOCKET_UNIT",
  "        content=b'[Socket]\\nListenStream=/run/kmj-codebridge-dev/supervisor.sock\\n'",
  "        mod.write_exclusive(p, content)",
  "        assert p.read_bytes()==content",
  "        assert not list(mod.UNIT_DIR.glob('.*.staging-*'))",
  "        try:mod.write_exclusive(p,b'OTHER')",
  "        except mod.Blocked:pass",
  "        else:raise AssertionError('overwrote existing unit')",
  "        assert p.read_bytes()==content",
  "        q=mod.UNIT_DIR/mod.SERVICE_UNIT",
  "        def racing_link(staged, target, **kwargs):",
  "            pathlib.Path(target).write_bytes(b'ANOTHER_OWNER')",
  "            raise FileExistsError()",
  "        with mock.patch.object(mod.os, 'link', side_effect=racing_link):",
  "            try:mod.write_exclusive(q, b'SHOULD_NOT_REPLACE')",
  "            except mod.Blocked:pass",
  "            else:raise AssertionError('did not reject competing unit')",
  "        assert q.read_bytes()==b'ANOTHER_OWNER'",
  "        assert not list(mod.UNIT_DIR.glob('.*.staging-*'))",
  "print('ATOMIC_CREATE_ONLY_UNIT_TEST_PASS')",
].join("\n");

test(
  "Elite dev Supervisor unit publication is atomic and collision-safe",
  { skip: !PYTHON },
  () => {
    const output = spawnSync("python3", ["-I", "-B", "-c", SCRIPT], {
      encoding: "utf8",
      timeout: 15000,
    });
    assert.equal(output.status, 0, output.stderr);
    assert.match(output.stdout, /ATOMIC_CREATE_ONLY_UNIT_TEST_PASS/);
  },
);

test("unit installer uses link-based create-only staging, never rename-overwrite", () => {
  const source = fs.readFileSync(FILE, "utf8");
  assert.match(source, /tempfile\.mkstemp\(/);
  assert.match(source, /os\.link\(staged, path, follow_symlinks=False\)/);
  assert.match(source, /os\.fsync\(fd\)/);
  assert.match(source, /os\.fsync\(dirfd\)/);
  assert.match(source, /"UNIT_ALREADY_EXISTS"/);
  assert.match(source, /"UNIT_ROLLBACK_IDENTITY_MISMATCH"/);
  assert.doesNotMatch(source, /os\.replace\(|os\.rename\(/);
});
