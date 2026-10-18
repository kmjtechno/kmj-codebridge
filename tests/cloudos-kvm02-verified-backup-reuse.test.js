import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(
  root,
  "scripts/production/retire-google-cloudos-simfleet-canaries.py",
);

test(
  "existing verified kvm02 backup succeeds with root-only parent, detects tampering, and no new tar",
  { skip: process.platform === "win32" },
  () => {
    const py = [
      "import contextlib,hashlib,importlib.util,io,os,pathlib,stat,tarfile,tempfile,sys",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('retire',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "mod.NAME='kvm02'",
      "with tempfile.TemporaryDirectory() as p:",
      "  root=pathlib.Path(p)",
      "  mod.ROOT=root",
      "  mod.BACKUP_BASE=root",
      "  mod.REUSE_KVM02_SUBDIR='verified-test-kvm02'",
      "  d=root/mod.REUSE_KVM02_SUBDIR;d.mkdir(mode=0o700)",
      "  arc=d/'kvm02.tar.gz'",
      "  with tarfile.open(arc,'w:gz') as t:",
      "    for name in ('kvm02','kvm02/dev','kvm02/dev/pts','kvm02/etc'):",
      "      m=tarfile.TarInfo(name);m.type=tarfile.DIRTYPE;t.addfile(m)",
      "    m=tarfile.TarInfo('kvm02/dev/null');m.type=tarfile.CHRTYPE;m.devmajor=1;m.devminor=3;t.addfile(m)",
      "    m=tarfile.TarInfo('kvm02/etc/issue');v=b'KMJ';m.size=len(v);t.addfile(m,io.BytesIO(v))",
      "  os.chmod(arc,0o644)",
      "  digest=hashlib.sha256(arc.read_bytes()).hexdigest()",
      "  mod.REUSE_KVM02_DIGEST=digest",
      "  manifest=d/'SHA256SUMS';manifest.write_text(digest+'  kvm02.tar.gz\\n');os.chmod(manifest,0o644)",
      "  orig=pathlib.Path.stat",
      "  def owned(self,*args,**kwargs):",
      "    v=list(orig(self,*args,**kwargs));v[4]=0;return os.stat_result(v)",
      "  with patch.object(pathlib.Path,'stat',owned):",
      "    with contextlib.redirect_stdout(io.StringIO()):",
      "      assert mod.existing_verified_kvm02_backup()==arc",
      "    arc.write_bytes(arc.read_bytes()+b'TAMPER')",
      "    try: mod.existing_verified_kvm02_backup()",
      "    except RuntimeError as e: assert str(e)=='EXISTING_BACKUP_CHECKSUM_MISMATCH'",
      "    else: raise AssertionError('ACCEPTED_TAMPERED_ARCHIVE')",
      "print('VERIFIED_REUSE_CHECK=PASS')",
    ].join("\n");
    const output = execFileSync("python3", ["-B", "-c", py, script], {
      cwd: root,
      timeout: 12000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /VERIFIED_REUSE_CHECK=PASS/);
  },
);

test(
  "machinectl failure records bounded private diagnostic and prints safe category",
  { skip: process.platform === "win32" },
  () => {
    const py = [
      "import contextlib,importlib.util,io,os,pathlib,stat,subprocess,sys,tempfile",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('retire',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "mod.NAME='kvm02'",
      "with tempfile.TemporaryDirectory() as p:",
      "  log=pathlib.Path(p)/'machinectl-diagnostic.log'",
      "  def failure(args,**opts):",
      "    assert args==['machinectl','remove','kvm02']",
      "    opts['stdout'].write(b'Could not remove image: Device or resource busy\\n')",
      "    return subprocess.CompletedProcess(args,1)",
      "  output=io.StringIO()",
      "  with patch.object(mod.subprocess,'run',side_effect=failure):",
      "    with contextlib.redirect_stdout(output):",
      "      try: mod.remove_with_diagnostics(log)",
      "      except RuntimeError as e: assert str(e)=='MACHINECTL_REMOVE_FAILED'",
      "      else: raise AssertionError('ACCEPTED_FAILED_REMOVE')",
      "  assert 'MACHINECTL_REMOVE_ERROR_CLASS=BUSY' in output.getvalue()",
      "  assert 'MACHINECTL_REMOVE_EXIT_CODE=1' in output.getvalue()",
      "  assert stat.S_IMODE(log.stat().st_mode)==0o600",
      "  assert b'Device or resource busy' in log.read_bytes()",
      "print('MACHINECTL_FAILURE_DIAGNOSTIC=PASS')",
    ].join("\n");
    const output = execFileSync("python3", ["-B", "-c", py, script], {
      cwd: root,
      timeout: 12000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /MACHINECTL_FAILURE_DIAGNOSTIC=PASS/);
  },
);
