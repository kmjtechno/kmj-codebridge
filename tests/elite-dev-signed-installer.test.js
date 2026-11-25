import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const FILE = "scripts/production/owner_install_elite_dev_supervisor.py";
const PYTHON = process.platform !== "win32";
const SHA = "a".repeat(40);
const CODE = [
  "import importlib.util,json",
  "spec=importlib.util.spec_from_file_location('installer','scripts/production/owner_install_elite_dev_supervisor.py')",
  "mod=importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(mod)",
  "rev='a'*40",
  "stem='kmj-codebridge-0.3.2-'+rev[:12]",
  "doc={'schema':1,'channel':'stable','product':'KMJ CodeBridge','keyId':'kmj-release-2026',",
  "     'revision':rev,'version':'0.3.2','sequence':40,'bytes':4096,'sha256':'b'*64,",
  "     'archive':'https://kmjtechno.com/codebridge/releases/stable/'+rev+'/'+stem+'.tar.gz'}",
  "d, gotstem, archive=mod.manifest_identity(json.dumps(doc).encode(),rev)",
  "assert gotstem==stem and archive==stem+'.tar.gz'",
  "for key,value in [('channel','beta'),('product','Other'),('keyId','attacker'),",
  "                  ('revision','b'*40),('sha256','x'*64),('bytes',0),",
  "                  ('sequence',True),('archive','https://evil.test/pkg.tar.gz')]:",
  "    broken=dict(doc);broken[key]=value",
  "    try:mod.manifest_identity(json.dumps(broken).encode(),rev)",
  "    except mod.Blocked:pass",
  "    else:raise AssertionError('accepted unsafe '+key)",
  "for wrong in ('main','','a'*39,'A'*40,'../'+rev):",
  "    try:mod.manifest_identity(json.dumps(doc).encode(),wrong)",
  "    except mod.Blocked:pass",
  "    else:raise AssertionError('accepted unsafe revision')",
  "print('OFFLINE_SIGNED_MANIFEST_SHAPE_GATES=PASS')",
].join("\n");

function invoke(...args) {
  return spawnSync("python3", args, { encoding: "utf8", timeout: 15000 });
}

test(
  "Elite signed installer rejects source identity substitution and malformed manifests",
  { skip: !PYTHON },
  () => {
    const result = invoke("-I", "-c", CODE);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /OFFLINE_SIGNED_MANIFEST_SHAPE_GATES=PASS/);
  },
);

test(
  "Elite signed installer rejects incomplete and fabricated owner commands before host work",
  { skip: !PYTHON },
  () => {
    for (const args of [
      [],
      ["--apply"],
      ["--revision", "main"],
      ["--revision", SHA, "--apply"],
      ["--revision", SHA, "--apply", "--force"],
    ]) {
      const result = invoke("-I", "-B", FILE, ...args);
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.match(
        result.stdout.trim(),
        /DEV_SUPERVISOR_INSTALL=BLOCKED_NO_LIVE_CREDIT$/,
      );
      assert.match(result.stdout, /DEV_SUPERVISOR_BLOCKER=[A-Z0-9_]+/);
    }
  },
);

test("Elite installer has fixed identities, signature gate, negative RPC and rollback", () => {
  const source = fs.readFileSync(FILE, "utf8");
  assert.match(
    source,
    /PIN = "2c49c1cea01c662416fd6b6bb4f1eb1d666165c5fcb58bebc436c7e6416c51f8"/,
  );
  assert.match(source, /AGENT_UNIT = "kmj-codebridge-dev.service"/);
  assert.match(source, /SOCKET_UNIT = "kmj-codebridge-dev-supervisor.socket"/);
  assert.match(
    source,
    /SERVICE_UNIT = "kmj-codebridge-dev-supervisor.service"/,
  );
  assert.match(source, /"PRIVATE_READ_ONLY_RPC_PASS"/);
  assert.match(
    source,
    /"DEV_SUPERVISOR_INSTALL=PASS_AGENT_BINDING_NOT_ATTEMPTED"/,
  );
  assert.match(source, /"DEV_AGENT_RESTART=NOT_ATTEMPTED"/);
  assert.match(source, /"OWNER_INSTALLER_MUST_RUN_FROM_SIGNED_RELEASE"/);
  assert.match(source, /"IMMUTABLE_SOURCE_BYTES_MISMATCH"/);
  assert.match(source, /"RUNTIME_WRITABLE_BY_AGENT"/);
  assert.match(source, /"DEV_SUPERVISOR_ROLLBACK=FAILED_MANUAL_RECOVERY"/);
  assert.doesNotMatch(source, /systemctl", "restart"/);
  assert.doesNotMatch(source, /systemctl", "reboot"/);
  assert.doesNotMatch(source, /rm -rf|chmod 777|chmod 666/);
});

const ARCHIVE_CODE = [
  "import importlib.util,io,tarfile",
  "spec=importlib.util.spec_from_file_location('installer','scripts/production/owner_install_elite_dev_supervisor.py')",
  "mod=importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(mod)",
  "stem='kmj-codebridge-0.3.2-'+'a'*12",
  "buf=io.BytesIO()",
  "with tarfile.open(fileobj=buf,mode='w:gz') as t:",
  "    root=tarfile.TarInfo(stem+'/');root.type=tarfile.DIRTYPE;t.addfile(root)",
  "    f=tarfile.TarInfo(stem+'/src/cli.js');f.size=0;t.addfile(f,io.BytesIO(b''))",
  "buf.seek(0)",
  "with tarfile.open(fileobj=buf,mode='r:gz') as t:",
  "    names=[(m.name,m.isdir()) for m in t]",
  "assert names[0]==(stem,True),names",
  "assert mod.archive_relative(stem,stem,True)==''",
  "assert mod.archive_relative(stem+'/src/cli.js',stem,False)=='src/cli.js'",
  "for name,is_dir in [(stem,False),('other/src/cli.js',False),(stem+'x/a',False),('/'+stem+'/a',False),('',True)]:",
  "    try:mod.archive_relative(name,stem,is_dir)",
  "    except mod.Blocked:pass",
  "    else:raise AssertionError('accepted '+repr(name))",
  "print('ARCHIVE_ROOT_ENTRY_ACCEPTED_ONLY_AS_DIRECTORY=PASS')",
].join("\n");

test(
  "git-archive root directory entry is accepted as the root, nothing else outside the signed prefix is",
  { skip: !PYTHON },
  () => {
    const result = invoke("-I", "-c", ARCHIVE_CODE);
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /ARCHIVE_ROOT_ENTRY_ACCEPTED_ONLY_AS_DIRECTORY=PASS/,
    );
  },
);

test("Elite private RPC probe uses unambiguous Node module format", () => {
  const source = fs.readFileSync(FILE, "utf8");
  assert.match(source, /import n from 'node:net'/);
  assert.match(source, /str\(NODE\), "--input-type=module", "-e", js/);
  assert.doesNotMatch(source, /const n=require\('node:net'\)/);
});

test("one-click setup preserves immutable unit and enrollment boundaries", () => {
  const source = fs.readFileSync(
    "scripts/production/owner_oneclick_elite_dev_supervisor.py",
    "utf8",
  );
  assert.match(source, /mod\.signed_source\(revision\)/);
  assert.match(source, /EXISTING_UNIT_BYTES_MISMATCH/);
  assert.match(source, /PARTIAL_UNIT_INSTALL_REVIEW_REQUIRED/);
  assert.match(source, /binding\.verify_private_config\(mod\) == digest/);
  assert.match(source, /ONECLICK_SETUP=STAGED_JOB_DRAINED_ACTIVATION_REQUIRED/);
  assert.doesNotMatch(source, /systemctl", "restart"/);
});
