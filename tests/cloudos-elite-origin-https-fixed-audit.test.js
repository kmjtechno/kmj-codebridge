import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";

function fixture(
  t,
  device = "kmj-elite-cloudos",
  project = "kmj-cloudos",
  writable = true,
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cloudos-elite-https-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo");
  fs.mkdirSync(root);
  const jobs = [];
  const runner = {
    maxConcurrent: 1,
    run: (job) => {
      jobs.push(job);
      return { id: "fixed-origin-audit", state: "queued" };
    },
  };
  const config = {
    id: device,
    stateDir: directory,
    projects: [{ id: project, root, writable, gates: {}, commands: {} }],
  };
  const dispatch = createDispatcher(config, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  const request = (extra = {}) => ({
    device,
    project,
    command: "cloudos_origin_https_audit",
    variant: "check",
    requestKey: "cloudos-https-preflight-test",
    ...extra,
  });
  return { root, jobs, dispatch, request };
}

test("fixed ELITE CloudOS origin audit is read-only and bounded", async (t) => {
  const f = fixture(t);
  const list = await f.dispatch(
    "list_project_commands",
    { device: "kmj-elite-cloudos", project: "kmj-cloudos" },
    ["read"],
  );
  const profile = list.commands.find(
    (cmd) => cmd.id === "cloudos_origin_https_audit",
  );
  assert.deepEqual(profile.variants, ["check"]);
  assert.equal(profile.risk, "READ");
  assert.equal(profile.approvalRequired, false);
  const job = await f.dispatch("run_project_command", f.request(), ["execute"]);
  assert.equal(job.state, "queued");
  assert.equal(f.jobs.length, 1);
  const cmd = f.jobs[0];
  assert.equal(cmd.project, "kmj-cloudos");
  assert.equal(cmd.cwd, f.root);
  assert.equal(cmd.command, "python3");
  assert.deepEqual(cmd.args.slice(0, 3), ["-I", "-B", "-c"]);
  assert.equal(cmd.timeoutMs, 30000);
  assert.match(cmd.args[3], /cloudos\.kmjtechno\.com/);
  assert.match(cmd.args[3], /127\.0\.0\.1/);
  assert.match(cmd.args[3], /server_hostname=HOST/);
  assert.match(cmd.args[3], /ssl\.create_default_context\(\)/);
  assert.doesNotMatch(cmd.args[3], /subprocess|os\.system|os\.remove|open\(.*['"]w/);
});

test("audit denies wrong device, project and caller overrides", async (t) => {
  const f = fixture(t);
  for (const extra of [
    { variant: "apply" },
    { variant: "issue-cert" },
    { variant: "cleanup" },
    { laneId: "other" },
    { expectedHead: "a".repeat(40) },
  ]) {
    await assert.rejects(
      f.dispatch("run_project_command", f.request(extra), ["execute"]),
      /COMMAND_NOT_ALLOWED/,
    );
  }
  await assert.rejects(
    f.dispatch("run_project_command", f.request(), ["read"]),
    /ACCESS_DENIED/,
  );
  for (const [device, project, writable] of [
    ["google-vps", "kmj-cloudos", true],
    ["kmj-elite-cloudos", "other-project", true],
    ["kmj-elite-cloudos", "kmj-cloudos", false],
  ]) {
    const other = fixture(t, device, project, writable);
    const list = await other.dispatch(
      "list_project_commands",
      { device, project },
      ["read"],
    );
    assert.equal(
      list.commands.some((item) => item.id === "cloudos_origin_https_audit"),
      false,
    );
    await assert.rejects(
      other.dispatch("run_project_command", other.request(), ["execute"]),
      /CLOUDOS_ORIGIN_HTTPS_AUDIT_NOT_AUTHORIZED/,
    );
  }
  assert.equal(f.jobs.length, 0);
});

test(
  "offline TLS and page checks never claim public release",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    await f.dispatch("run_project_command", f.request(), ["execute"]);
    const program = f.jobs[0].args[3];
    const driver = String.raw`
import socket,ssl,http.client,sys,json
scenario=sys.argv[2]
socket.gethostname=lambda: 'not-elite' if scenario == 'wronghost' else 'KMJ-elite'
class Response:
 def __init__(self,mode='ok'): self.status=302 if mode == 'redirect' else 200;self.mode=mode
 def getheader(self,key,default=''): return 'text/html; charset=utf-8'
 def begin(self): pass
 def read(self,n):
  return (b'<title>Main Platform' if self.mode == 'page' else b'<title>CloudOS')
class FakeHTTP:
 def __init__(self,*args,**kwargs):
  assert args[0]=='127.0.0.1' and args[1]==8080 and kwargs['timeout']==4
 def request(self,*args,**kwargs): pass
 def getresponse(self): return Response()
 def close(self): pass
class Sock:
 def __enter__(self): return self
 def __exit__(self,*args): return False
 def settimeout(self,timeout): assert timeout==4
 def sendall(self,value): assert b'GET /info HTTP/1.1' in value and b'Host: cloudos.kmjtechno.com' in value
class Context:
 def wrap_socket(self,raw,server_hostname):
  assert server_hostname=='cloudos.kmjtechno.com'
  if scenario=='cert': raise ssl.SSLError('invalid cert')
  return Sock()
http.client.HTTPConnection=FakeHTTP
http.client.HTTPResponse=lambda conn: Response('page' if scenario=='page' else 'redirect' if scenario=='redirect' else 'ok')
socket.create_connection=lambda addr,timeout: Sock() if addr==('127.0.0.1',443) and timeout==4 else (_ for _ in ()).throw(AssertionError('wrong target'))
ssl.create_default_context=lambda: Context()
exec(sys.argv[1], {'__name__':'__main__'})
  `;
    const run = (mode) =>
      spawnSync("python3", ["-I", "-B", "-c", driver, program, mode], {
        timeout: 10000,
        encoding: "utf8",
      });
    const healthy = run("ok");
    assert.equal(healthy.status, 0, healthy.stderr);
    const result = JSON.parse(healthy.stdout);
    assert.equal(result.local_origin_readiness, "PASS_LOCAL_ONLY");
    assert.equal(result.external_https_reachability, "NOT_VERIFIED");
    assert.equal(result.commercial_release, "NOT_APPROVED");
    assert.equal(result.host_modified, false);
    for (const mode of ["cert", "page", "redirect"]) {
      const blocked = run(mode);
      assert.equal(blocked.status, 3, blocked.stderr);
      const receipt = JSON.parse(blocked.stdout);
      assert.equal(receipt.local_origin_readiness, "BLOCKED");
      assert.equal(receipt.external_https_reachability, "NOT_VERIFIED");
    }
    const wrong = run("wronghost");
    assert.equal(wrong.status, 2, wrong.stderr);
    assert.match(wrong.stdout, /CLOUDOS_ORIGIN_HTTPS_AUDIT=BLOCKED_WRONG_HOST/);
  },
);
