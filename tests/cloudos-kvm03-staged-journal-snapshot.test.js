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
  "kvm03 stopped guest copies journal to stable staging, validates tar, removes staging",
  { skip: process.platform === "win32" },
  () => {
    const py = [
      "import contextlib,hashlib,importlib.util,io,os,pathlib,stat,subprocess,sys,tarfile,tempfile",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('retire',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "mod.NAME='kvm03'",
      "mod.MIN_FREE_AFTER_BACKUP=1024",
      "mod.avail=lambda:1024**4",
      "with tempfile.TemporaryDirectory() as p:",
      "  base=pathlib.Path(p)",
      "  mod.ROOT=base",
      "  mod.IMAGE=base/'kvm03'",
      "  journal=mod.IMAGE/'var/log/journal/b98e13c524624876bd0d4c09ca219b58'",
      "  journal.mkdir(parents=True)",
      "  target=journal/'system.journal'",
      "  target.write_text('BEFORE-STAGE')",
      "  out=base/'backup';out.mkdir(mode=0o700)",
      "  original_run=subprocess.run",
      "  def mutate_after_copy(argv,**kwargs):",
      "    p=original_run(argv,**kwargs)",
      "    if argv[0]=='cp' and p.returncode==0: target.write_text('AFTER-STAGE')",
      "    return p",
      "  original_lstat=pathlib.Path.lstat",
      "  def pretend_root(self,*args,**kwargs):",
      "    result=original_lstat(self,*args,**kwargs)",
      "    if str(self).endswith('/.kvm03-staging-root/kvm03'):",
      "      values=list(result);values[4]=0;return os.stat_result(values)",
      "    return result",
      "  with patch.object(pathlib.Path,'lstat',pretend_root), patch.object(mod.subprocess,'run',side_effect=mutate_after_copy):",
      "    with contextlib.redirect_stdout(io.StringIO()) as output:",
      "      archive=mod.staged_backup_guest(out)",
      "  assert archive.exists()",
      "  assert not (out/'.kvm03-staging-root').exists()",
      "  with tarfile.open(archive,'r:gz') as t:",
      "    name='kvm03/var/log/journal/b98e13c524624876bd0d4c09ca219b58/system.journal'",
      "    assert t.extractfile(name).read()==b'BEFORE-STAGE'",
      "  assert 'STAGING_JOURNAL_OMITTED=NO' in output.getvalue()",
      "  assert 'STAGING_COPY_CLEANUP=PASS' in output.getvalue()",
      "  assert (out/'SHA256SUMS').exists()",
      "print('KVM03_COMPLETE_SNAPSHOT_ARCHIVE=PASS')",
    ].join("\n");
    const out = execFileSync("python3", ["-B", "-c", py, script], {
      cwd: root,
      timeout: 20000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(out, /KVM03_COMPLETE_SNAPSHOT_ARCHIVE=PASS/);
  },
);

test(
  "kvm03 staging failure never creates archive and cleans staging copy",
  { skip: process.platform === "win32" },
  () => {
    const py = [
      "import contextlib,importlib.util,io,os,pathlib,stat,subprocess,sys,tempfile",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('retire',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      "mod.NAME='kvm03';mod.MIN_FREE_AFTER_BACKUP=1024;mod.avail=lambda:1024**4",
      "with tempfile.TemporaryDirectory() as p:",
      "  root=pathlib.Path(p);mod.IMAGE=root/'kvm03';mod.IMAGE.mkdir()",
      "  mod.ROOT=root",
      "  (mod.IMAGE/'synthetic-fixture.bin').write_bytes(b'KMJ' * 1024)",
      "  out=root/'backup';out.mkdir(mode=0o700)",
      "  original_run=subprocess.run",
      "  def failed_copy(argv,**kwargs):",
      "    if argv[0]!='cp':return original_run(argv,**kwargs)",
      "    kwargs['stderr'].write(b'synthetic cp failure\\n')",
      "    return subprocess.CompletedProcess(argv,1)",
      "  with patch.object(mod.subprocess,'run',side_effect=failed_copy):",
      "    with contextlib.redirect_stdout(io.StringIO()) as output:",
      "      try: mod.staged_backup_guest(out)",
      "      except RuntimeError as e: assert str(e)=='STAGING_COPY_FAILED'",
      "      else: raise AssertionError('accepted failed cp')",
      "  assert not (out/'.kvm03-staging-root').exists()",
      "  assert not (out/'kvm03.tar.gz').exists()",
      "  assert stat.S_IMODE((out/'copy-diagnostic.log').stat().st_mode)==0o600",
      "  assert 'STAGING_COPY_CLEANUP=PASS' in output.getvalue()",
      "print('KVM03_STAGING_FAILURE_ROLLBACK=PASS')",
    ].join("\n");
    const out = execFileSync("python3", ["-B", "-c", py, script], {
      cwd: root,
      timeout: 20000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(out, /KVM03_STAGING_FAILURE_ROLLBACK=PASS/);
  },
);
