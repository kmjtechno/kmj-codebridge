import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(
  root,
  "scripts/production/retire-google-cloudos-simfleet-canaries.py",
);
const source = fs.readFileSync(script, "utf8");

test(
  "two-guest canary enforces kvm02 and kvm03 allowlist in actual Python CLI",
  { skip: process.platform === "win32" },
  () => {
    const py = [
      "import contextlib,importlib.util,io,os,pathlib,sys,tempfile",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('simfleet',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "with tempfile.TemporaryDirectory() as root:",
      "  mod.LOCK=pathlib.Path(root)/'retirement.lock'",
      "  with patch.object(mod,'identity',return_value=None), patch.object(mod,'avail',return_value=20*1024**3):",
      "    for target in ('kvm02','kvm03'):",
      "      with patch.object(sys,'argv',['cmd','--guest',target]):",
      "        assert mod.main()==0",
      "        assert mod.NAME==target",
      "        assert mod.UNIT=='systemd-nspawn@'+target+'.service'",
      "        assert mod.IMAGE==mod.ROOT/target",
      "    for invalid in ('kvm01','shared01','util01','upg01','../../etc'):",
      "      with patch.object(sys,'argv',['cmd','--guest',invalid]):",
      "        with contextlib.redirect_stderr(io.StringIO()):",
      "          try: mod.main()",
      "          except SystemExit as ex: assert ex.code==2,invalid",
      "          else: raise AssertionError('UNAUTHORIZED_GUEST_ACCEPTED:'+invalid)",
      "print('SIMFLEET_ALLOWLIST=PASS')",
    ].join("\n");
    const result = execFileSync("python3", ["-B", "-c", py, script], {
      cwd: root,
      timeout: 12000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(result, /SIMFLEET_ALLOWLIST=PASS/);
  },
);

test("only approved nspawn guests may be retired; no raw shell or LXD operations", () => {
  for (const marker of [
    'ALLOWED_GUESTS = ("kvm02", "kvm03")',
    'parser.add_argument("--guest", choices=ALLOWED_GUESTS, required=True)',
    'LOCK = Path("/run/lock/kmj-cloudos-simfleet-retirement.lock")',
    "BACKUP_BASE_PERMISSIONS_UNSAFE",
    "LOCAL_BACKUP_VALIDATED=YES",
    "ARCHIVE_DEVICE_NODES_VALIDATED",
    "CANARY_ROLLBACK=GUEST_RUNNING",
    "NET_SPACE_GAIN_BYTES",
    "CLOUDOS_API_WORKER_AGENT_DASHBOARD=PASS",
    "LIVE_SERVICE_REFERENCES_GUEST",
    "MOUNT",
    "OTHER_GUEST_REMOVALS=NOT_AUTHORIZED",
  ]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.doesNotMatch(source, /lxc.*(?:delete|stop|restart|exec)/i);
  assert.doesNotMatch(source, /(?:rm\s+-rf|shell\s*=\s*True|\bvirsh\b)/);
  assert.doesNotMatch(source, /machinectl.*--force/);
});

test(
  "archive can safely round-trip device entry while rejecting cross-guest entry",
  { skip: process.platform === "win32" },
  () => {
    const py = [
      "import contextlib,importlib.util,io,sys,tempfile,pathlib,tarfile",
      "spec=importlib.util.spec_from_file_location('simfleet',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "for guest in ('kvm02','kvm03'):",
      "  mod.NAME=guest",
      "  with tempfile.TemporaryDirectory() as root:",
      "    mod.ROOT=pathlib.Path(root)",
      "    for bad in (False,True):",
      "      fn=pathlib.Path(root)/('bad.tar.gz' if bad else 'good.tar.gz')",
      "      with tarfile.open(fn,'w:gz') as tf:",
      "        for name in (guest,guest+'/dev',guest+'/etc'):",
      "          m=tarfile.TarInfo(name);m.type=tarfile.DIRTYPE;tf.addfile(m)",
      "        m=tarfile.TarInfo(guest+'/dev/null' if not bad else 'shared01/dev/null')",
      "        m.type=tarfile.CHRTYPE;m.devmajor=1;m.devminor=3;tf.addfile(m)",
      "        m=tarfile.TarInfo(guest+'/etc/issue');data=b'KMJ';m.size=len(data);tf.addfile(m,io.BytesIO(data))",
      "        m=tarfile.TarInfo(guest+'/dev/pts');m.type=tarfile.DIRTYPE;tf.addfile(m)",
      "      with contextlib.redirect_stdout(io.StringIO()):",
      "        if bad:",
      "          try: mod.validate_archive(fn)",
      "          except RuntimeError as ex: assert 'ARCHIVE_UNSAFE_ENTRY' in str(ex)",
      "          else: raise AssertionError('ACCEPTED_OTHER_GUEST')",
      "        else: assert mod.validate_archive(fn)>=6",
      "print('SIMFLEET_ARCHIVES=PASS')",
    ].join("\n");
    const result = execFileSync("python3", ["-B", "-c", py, script], {
      cwd: root,
      timeout: 12000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(result, /SIMFLEET_ARCHIVES=PASS/);
  },
);
