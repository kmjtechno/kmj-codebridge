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
  "nspawn archive accepts /dev character nodes, rejects unsafe members, preserves staged recovery",
  { skip: process.platform === "win32" },
  () => {
    const python = [
      "import importlib.util,io,tarfile,tempfile,pathlib,contextlib,os,sys",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('canary',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(mod)",
      "def make(mode):",
      "    t=tempfile.TemporaryDirectory()",
      "    p=pathlib.Path(t.name)/'guest.tar.gz'",
      "    with tarfile.open(p,'w:gz') as ar:",
      "        for n in ('kvm01','kvm01/dev','kvm01/etc'):",
      "            m=tarfile.TarInfo(n);m.type=tarfile.DIRTYPE;ar.addfile(m)",
      "        m=tarfile.TarInfo('kvm01/dev/null' if mode!='outside' else 'kvm01/etc/raw')",
      "        m.type=tarfile.CHRTYPE;m.devmajor=1;m.devminor=3;ar.addfile(m)",
      "        m=tarfile.TarInfo('kvm01/etc/issue');data=b'KMJ\\n';m.size=len(data);ar.addfile(m,io.BytesIO(data))",
      "        m=tarfile.TarInfo('kvm01/dev/pts');m.type=tarfile.DIRTYPE;ar.addfile(m)",
      "        if mode=='traversal':",
      "            m=tarfile.TarInfo('kvm01/../../outside');ar.addfile(m,io.BytesIO(b''))",
      "        if mode=='hardlink':",
      "            m=tarfile.TarInfo('kvm01/etc/hard');m.type=tarfile.LNKTYPE;m.linkname='../sibling/private';ar.addfile(m)",
      "        if mode=='symlink-parent':",
      "            m=tarfile.TarInfo('kvm01/etc/foo');m.type=tarfile.SYMTYPE;m.linkname='/tmp';ar.addfile(m)",
      "            m=tarfile.TarInfo('kvm01/etc/foo/child');ar.addfile(m,io.BytesIO(b''))",
      "    return t,p",
      "t,p=make('normal')",
      "mod.ROOT=p.parent",
      "try:",
      "    with contextlib.redirect_stdout(io.StringIO()):",
      "        assert mod.validate_archive(p)>=6",
      "finally: t.cleanup()",
      "for mode,code in [('outside','ARCHIVE_UNSAFE_DEVICE_LOCATION'),('traversal','ARCHIVE_UNSAFE_ENTRY'),('hardlink','ARCHIVE_UNSAFE_HARDLINK'),('symlink-parent','ARCHIVE_SYMLINK_PARENT')]:",
      "    t,p=make(mode)",
      "    mod.ROOT=p.parent",
      "    try:",
      "        try:",
      "            with contextlib.redirect_stdout(io.StringIO()): mod.validate_archive(p)",
      "        except RuntimeError as e:",
      "            assert code in str(e),(mode,e)",
      "        else: raise AssertionError('ACCEPTED_UNSAFE_'+mode)",
      "    finally: t.cleanup()",
      "print('SPECIAL_NODE_ARCHIVE_POLICY=PASS')",
    ].join("\n");
    const output = execFileSync("python3", ["-B", "-c", python, script], {
      cwd: root,
      timeout: 15000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(output, /SPECIAL_NODE_ARCHIVE_POLICY=PASS/);
  },
);
