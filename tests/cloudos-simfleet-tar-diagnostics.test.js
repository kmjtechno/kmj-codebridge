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
  "failed GNU tar identifies cause, safely removes only newly-created incomplete bytes",
  { skip: process.platform === "win32" },
  () => {
    const py = [
      "import contextlib,importlib.util,io,os,pathlib,stat,subprocess,sys,tempfile",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('testsim',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "mod.NAME='kvm02'",
      "with tempfile.TemporaryDirectory() as work:",
      "  root=pathlib.Path(work)",
      "  previous=root/'previous';previous.mkdir()",
      "  (previous/'SHA256SUMS').write_text('VERIFIED_BACKUP')",
      "  dest=root/'new';dest.mkdir()",
      "  def fake_tar(args,**kw):",
      "    kw['stdout'].write(b'INCOMPLETE_STREAM')",
      "    kw['stderr'].write(b'tar: kvm02/path: file changed as we read it\\n')",
      "    return subprocess.CompletedProcess(args,1)",
      "  result=io.StringIO()",
      "  with patch.object(mod.subprocess,'run',side_effect=fake_tar):",
      "    with contextlib.redirect_stdout(result):",
      "      try: mod.backup_guest(dest)",
      "      except RuntimeError as exc: assert str(exc)=='ARCHIVE_CREATE_FAILED'",
      "      else: raise AssertionError('ACCEPTED_INCOMPLETE_BACKUP')",
      "  output=result.getvalue()",
      "  assert 'ARCHIVE_CREATE_EXIT_CODE=1' in output",
      "  assert 'ARCHIVE_CREATE_ERROR_CLASS=SOURCE_CHANGED' in output",
      "  assert 'THIS_ATTEMPT_UNVERIFIED_PARTIAL_REMOVED=YES' in output",
      "  assert 'kvm02/path' not in output",
      "  assert not (dest/'.kvm02.tar.gz.unverified-partial').exists()",
      "  assert not (dest/'SHA256SUMS').exists()",
      "  assert (previous/'SHA256SUMS').read_text()=='VERIFIED_BACKUP'",
      "  log=dest/'tar-diagnostic.log'",
      "  assert log.is_file()",
      "  assert stat.S_IMODE(log.stat().st_mode)==0o600",
      "print('TAR_FAILURE_DIAG_AND_PARTIAL_CLEANUP=PASS')",
    ].join("\n");

    const output = execFileSync("python3", ["-B", "-c", py, script], {
      cwd: root,
      timeout: 10000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /TAR_FAILURE_DIAG_AND_PARTIAL_CLEANUP=PASS/);
  },
);

test(
  "successful tar creates a SHA-verified archive, never an unverified partial",
  { skip: process.platform === "win32" },
  () => {
    const py = [
      "import contextlib,importlib.util,io,pathlib,subprocess,sys,tempfile,tarfile",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('testsim',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "mod.NAME='kvm03'",
      "with tempfile.TemporaryDirectory() as work:",
      "  dest=pathlib.Path(work)",
      "  mod.ROOT=dest",
      "  def fake_tar(args,**kw):",
      "    with tarfile.open(fileobj=kw['stdout'],mode='w|gz') as tf:",
      "      for name in ('kvm03','kvm03/dev','kvm03/dev/pts','kvm03/etc'):",
      "        m=tarfile.TarInfo(name);m.type=tarfile.DIRTYPE;tf.addfile(m)",
      "      m=tarfile.TarInfo('kvm03/dev/null')",
      "      m.type=tarfile.CHRTYPE;m.devmajor=1;m.devminor=3;tf.addfile(m)",
      "      d=b'KMJ';m=tarfile.TarInfo('kvm03/etc/issue');m.size=len(d)",
      "      tf.addfile(m,io.BytesIO(d))",
      "    return subprocess.CompletedProcess(args,0)",
      "  with patch.object(mod.subprocess,'run',side_effect=fake_tar),patch.object(mod,'avail',return_value=20*1024**3):",
      "    with contextlib.redirect_stdout(io.StringIO()):",
      "      archive=mod.backup_guest(dest)",
      "  assert archive.is_file()",
      "  assert (dest/'SHA256SUMS').is_file()",
      "  assert not (dest/'.kvm03.tar.gz.unverified-partial').exists()",
      "print('VERIFIED_TAR_ARCHIVE=PASS')",
    ].join("\n");

    const output = execFileSync("python3", ["-B", "-c", py, script], {
      cwd: root,
      timeout: 10000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /VERIFIED_TAR_ARCHIVE=PASS/);
  },
);
