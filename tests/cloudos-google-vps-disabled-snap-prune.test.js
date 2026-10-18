import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(
  root,
  "scripts/production/google-vps-disabled-snap-prune.py",
);

function pythonCheck(title, statements) {
  test(title, { skip: process.platform === "win32" }, () => {
    const program = [
      "import importlib.util,sys",
      "from unittest.mock import patch",
      "spec=importlib.util.spec_from_file_location('audit',sys.argv[1])",
      "mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)",
      ...statements,
      "print('ASSERTIONS_PASS')",
    ].join("\n");
    const result = execFileSync("python3", ["-B", "-c", program, script], {
      cwd: root,
      encoding: "utf8",
      timeout: 12000,
    });
    assert.match(result, /ASSERTIONS_PASS/);
  });
}

pythonCheck("snap revision selection requires disabled and active replacement", [
  "header='Name Version Rev Tracking Publisher Notes\\n'",
  "lines='core24 2026 1643 stable canonical base,disabled\\ncore24 2026 1644 stable canonical base\\n'",
  "rows=mod.parse_snap_list(header+lines)",
  "assert mod.status_for(rows,'core24','1643')=='DISABLED_WITH_ACTIVE_REPLACEMENT'",
  "assert mod.status_for(rows,'core24','1111')=='ABSENT'",
  "try: mod.status_for(rows,'core24','1644')",
  "except RuntimeError as e: assert str(e)=='TARGET_REVISION_IS_ACTIVE'",
  "else: raise AssertionError('ACCEPTED_ACTIVE_REVISION')",
  "try: mod.status_for({'core24':[('1643',True)]},'core24','1643')",
  "except RuntimeError as e: assert str(e)=='ACTIVE_REPLACEMENT_MISSING'",
  "else: raise AssertionError('ACCEPTED_NO_REPLACEMENT')",
]);

pythonCheck("malformed and ambiguous snap tables are rejected", [
  "for bad in ('', 'whatever here\\n', 'Name Version Rev Tracking Publisher Notes\\ncore24 hi\\n', 'Name Version Rev Tracking Publisher Notes\\ncore24 a nope track owner disabled\\n'):",
  "  try: mod.parse_snap_list(bad)",
  "  except RuntimeError: pass",
  "  else: raise AssertionError('ACCEPTED_BAD_TABLE')",
  "rows={'core24':[('1643',True),('1643',True),('1644',False)]}",
  "try: mod.status_for(rows,'core24','1643')",
  "except RuntimeError as e: assert str(e)=='SNAP_DUPLICATE_REVISION'",
  "else: raise AssertionError('ACCEPTED_DUPLICATE')",
]);

pythonCheck("only exact hardcoded revision can reach snap remove", [
  "import io,contextlib,os,tempfile",
  "header='Name Version Rev Tracking Publisher Notes\\n'",
  "lines='core24 2026 1643 stable canonical base,disabled\\ncore24 2026 1644 stable canonical base\\n'",
  "log=[]",
  "def fake_run(argv,timeout=30):",
  "  log.append(tuple(argv))",
  "  if argv==['snap','list','--all']: return header+lines",
  "  if argv==['snap','remove','core24','--revision=1643']: return ''",
  "  raise AssertionError('UNEXPECTED_COMMAND:'+str(argv))",
  "with tempfile.TemporaryDirectory() as tmp:",
  "  with patch.object(mod,'identify'),patch.object(mod,'health'),patch.object(mod,'run',fake_run),patch.object(mod,'LOCK',mod.Path(tmp)/'lock'),patch.object(sys,'argv',['prune','--apply']):",
  "    with contextlib.redirect_stdout(io.StringIO()) as out:",
  "      assert mod.main()==0",
  "    assert 'SNAP_CLEANUP=PASS' in out.getvalue()",
  "    assert log.count(('snap','remove','core24','--revision=1643'))==1",
  "    assert not any(x[0]=='snap' and x[1]=='remove' and x[2]!='core24' for x in log)",
]);

pythonCheck("audit never changes the host", [
  "import io,contextlib,tempfile",
  "header='Name Version Rev Tracking Publisher Notes\\n'",
  "lines='core24 2026 1643 stable canonical base,disabled\\ncore24 2026 1644 stable canonical base\\n'",
  "log=[]",
  "def fake_run(argv,timeout=30):",
  "  log.append(tuple(argv))",
  "  if argv==['snap','list','--all']: return header+lines",
  "  raise AssertionError('UNEXPECTED_COMMAND')",
  "with tempfile.TemporaryDirectory() as tmp:",
  "  with patch.object(mod,'identify'),patch.object(mod,'health'),patch.object(mod,'run',fake_run),patch.object(mod,'LOCK',mod.Path(tmp)/'lock'),patch.object(sys,'argv',['prune']):",
  "    with contextlib.redirect_stdout(io.StringIO()) as out:",
  "      assert mod.main()==0",
  "    assert 'HOST_CHANGES=NONE' in out.getvalue()",
  "    assert not any(x[0]=='snap' and x[1]=='remove' for x in log)",
]);
