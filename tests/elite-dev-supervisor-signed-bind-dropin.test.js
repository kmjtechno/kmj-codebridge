import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "scripts/production/owner_stage_elite_dev_supervisor_binding.py";
const LINUX = process.platform === "linux";
const REV = "a".repeat(40);

function python(code) {
  return spawnSync("python3", ["-I", "-B", "-c", code], {
    encoding: "utf8",
    timeout: 15000,
  });
}

test(
  "owner dev binding refuses invalid argument and never changes a host",
  {
    skip: !LINUX,
  },
  () => {
    for (const args of [
      [],
      ["--apply"],
      ["--revision", REV, "--apply"],
      ["--revision", "main"],
      ["--revision", REV, "--force"],
    ]) {
      const result = spawnSync("python3", ["-I", "-B", FILE, ...args], {
        encoding: "utf8",
        timeout: 15000,
      });
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(result.stdout, /BLOCKED_NO_LIVE_CREDIT/);
    }
  },
);

test("signed root binding stages only the fixed drop-in with no restart or token writes", () => {
  const source = fs.readFileSync(FILE, "utf8");
  assert.match(source, /owner_install_elite_dev_supervisor\.py/);
  assert.match(source, /mod\.signed_source\(revision\)/);
  assert.match(source, /OWNER_BINDING_MUST_RUN_FROM_SIGNED_RELEASE/);
  assert.match(source, /ROOT_SIGNED_SOURCE_REQUIRED/);
  assert.match(source, /80-kmj-signed-dev-supervisor-binding\.conf/);
  assert.match(source, /KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND=1/);
  assert.match(source, /DEV_BINDING_ROOT_DROPIN=STAGED_NO_AGENT_RESTART/);
  assert.match(source, /DEV_AGENT_BINDING_LIVE_RPC=NOT_YET_VERIFIED/);
  assert.match(source, /mod\.private_socket_probe\(\)/);
  assert.match(source, /DEV_CONFIG_MUTATED/);
  assert.match(source, /DROPIN_ROLLBACK_INODE_MISMATCH/);
  assert.match(source, /DEV_CONFIG_DIRECTORY_UNTRUSTED/);
  assert.match(source, /DEV_CONFIG_CHANGED_DURING_READ/);
  assert.match(source, /binding_env_is_exact\(after\.get\("Environment"/);
  assert.match(source, /os\.link\(stage, DROPIN, follow_symlinks=False\)/);
  assert.doesNotMatch(source, /systemctl", "restart"/);
  assert.doesNotMatch(source, /systemctl", "stop"/);
  assert.doesNotMatch(source, /os\.replace\(|git reset|git clean|rm -rf/);
});

const HERMETIC = [
  "import importlib.util, pathlib, tempfile, os, types",
  "from unittest import mock",
  "spec=importlib.util.spec_from_file_location('bind', 'scripts/production/owner_stage_elite_dev_supervisor_binding.py')",
  "b=importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(b)",
  "with tempfile.TemporaryDirectory(prefix='kmj-bind-atomic-') as path:",
  "    b.DIRECTORY=pathlib.Path(path)",
  "    b.DROPIN=b.DIRECTORY/'80-kmj-signed-dev-supervisor-binding.conf'",
  "    dummy=types.SimpleNamespace(root_parents=lambda x: None,",
  "       root_file=lambda x,n: pathlib.Path(x).read_bytes(),",
  "       run=lambda argv: '')",
  "    old_fstat=os.fstat",
  "    def root_stat(fd):",
  "        s=old_fstat(fd)",
  "        return types.SimpleNamespace(st_uid=0,st_mode=s.st_mode,st_nlink=s.st_nlink,st_size=s.st_size,st_dev=s.st_dev,st_ino=s.st_ino)",
  "    b.trust_dropin_dir=lambda _mod: None",
  "    with mock.patch.object(b.os, 'fstat', side_effect=root_stat):",
  "        created=b.write_once(dummy)",
  "        assert created==(os.lstat(b.DROPIN).st_dev,os.lstat(b.DROPIN).st_ino)",
  "        assert b.DROPIN.read_bytes()==b.TEXT",
  "        assert not list(b.DIRECTORY.glob('.kmj-bind-staged-*'))",
  "        try:b.write_once(dummy,b'OTHER')",
  "        except b.Blocked:pass",
  "        else:raise AssertionError('overwrote root dropin')",
  "        assert b.DROPIN.read_bytes()==b.TEXT",
  "        b.DROPIN.unlink()",
  "        def competitor(staged, target, **kwargs):",
  "            pathlib.Path(target).write_bytes(b'UNRELATED_UNIT')",
  "            raise FileExistsError()",
  "        with mock.patch.object(b.os,'link',side_effect=competitor):",
  "            try:b.write_once(dummy)",
  "            except b.Blocked:pass",
  "            else:raise AssertionError('raced EEXIST was accepted')",
  "        assert b.DROPIN.read_bytes()==b'UNRELATED_UNIT'",
  "        assert not list(b.DIRECTORY.glob('.kmj-bind-staged-*'))",
  "        identity=(os.lstat(b.DROPIN).st_dev,os.lstat(b.DROPIN).st_ino)",
  "        try:b.remove_owned(dummy,(identity[0],identity[1]+1))",
  "        except b.Blocked:pass",
  "        else:raise AssertionError('deleted replacement inode')",
  "        assert b.DROPIN.read_bytes()==b'UNRELATED_UNIT'",
  "        try:b.remove_owned(dummy,identity)",
  "        except b.Blocked:pass",
  "        else:raise AssertionError('deleted unrelated unit')",
  "        assert b.DROPIN.read_bytes()==b'UNRELATED_UNIT'",
  "print('ROOT_DROPIN_ATOMIC_COLLISION_PASS')",
].join("\n");

test(
  "root-only staging is atomic and refuses collisions or replacement",
  {
    skip: !LINUX,
  },
  () => {
    const out = python(HERMETIC);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /ROOT_DROPIN_ATOMIC_COLLISION_PASS/);
  },
);

test(
  "effective systemd environment must contain exactly one authorized flag",
  { skip: !LINUX },
  () => {
    const out = python(
      [
        "import importlib.util",
        "spec=importlib.util.spec_from_file_location('b','scripts/production/owner_stage_elite_dev_supervisor_binding.py')",
        "b=importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(b)",
        "assert b.binding_env_is_exact(b.FLAG)",
        "assert b.binding_env_is_exact('PATH=/usr/bin '+b.FLAG+' OTHER=x')",
        "for x in ['', b.FLAG+'evil', b.FLAG+' '+b.FLAG, 'KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND=0', b.FLAG+' KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND=0']:",
        "    assert not b.binding_env_is_exact(x)",
        "print('EXACT_BINDING_FLAG_PASS')",
      ].join("\n"),
    );
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /EXACT_BINDING_FLAG_PASS/);
  },
);
