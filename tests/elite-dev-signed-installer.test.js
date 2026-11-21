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
      assert.equal(
        result.stdout.trim(),
        "DEV_SUPERVISOR_INSTALL=BLOCKED_NO_LIVE_CREDIT",
      );
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
