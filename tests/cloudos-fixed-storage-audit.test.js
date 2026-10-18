import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";

function fixture(
  t,
  device = "google-vps",
  project = "kmj-cloudos",
  writable = true,
) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-cloudos-host-audit-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const root = path.join(tmp, "repo");
  const stateDir = path.join(tmp, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  const jobs = [];
  const runner = {
    maxConcurrent: 1,
    run: (job) => {
      jobs.push(job);
      return { id: "bounded-job", state: "queued" };
    },
  };
  const config = {
    id: device,
    stateDir,
    projects: [{ id: project, root, writable, gates: {}, commands: {} }],
  };
  const dispatch = createDispatcher(config, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  const request = (overrides = {}) => ({
    device,
    project,
    command: "cloudos_host_storage_audit",
    variant: "overview",
    requestKey: "disk-audit-fixed-v1",
    ...overrides,
  });
  return { dispatch, jobs, request, root };
}

test("host audit command is fixed, read-only and needs no supervisor", async (t) => {
  const f = fixture(t);
  const listing = await f.dispatch(
    "list_project_commands",
    { device: "google-vps", project: "kmj-cloudos" },
    ["read"],
  );
  const profile = listing.commands.find(
    (cmd) => cmd.id === "cloudos_host_storage_audit",
  );
  assert.deepEqual(profile.variants, ["overview"]);
  assert.equal(profile.risk, "READ");
  assert.equal(profile.approvalRequired, false);
  const response = await f.dispatch("run_project_command", f.request(), [
    "execute",
  ]);
  assert.equal(response.state, "queued");
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0];
  assert.equal(job.cwd, f.root);
  assert.equal(job.project, "kmj-cloudos");
  assert.equal(job.key, "disk-audit-fixed-v1");
  assert.equal(job.command, "python3");
  assert.deepEqual(job.args.slice(0, 3), ["-I", "-B", "-c"]);
  assert.match(job.args[3], /google-vps1/);
  assert.match(job.args[3], /du/);
  assert.match(job.args[3], /df/);
  assert.match(job.args[3], /systemctl/);
  assert.doesNotMatch(job.args[3], /subprocess\.run\(.*shell=True/);
  assert.equal(job.timeoutMs, 180000);
});

test("host audit rejects overrides and wrong project/device", async (t) => {
  const f = fixture(t);
  for (const override of [
    { variant: "apply" },
    { variant: "cleanup" },
    { laneId: "unrelated" },
    { expectedHead: "a".repeat(40) },
  ]) {
    await assert.rejects(
      f.dispatch("run_project_command", f.request(override), ["execute"]),
      /COMMAND_NOT_ALLOWED/,
    );
  }
  await assert.rejects(
    f.dispatch("run_project_command", f.request(), ["read"]),
    /ACCESS_DENIED/,
  );
  for (const [device, project, writable] of [
    ["not-google-vps", "kmj-cloudos", true],
    ["google-vps", "unrelated", true],
    ["google-vps", "kmj-cloudos", false],
  ]) {
    const other = fixture(t, device, project, writable);
    const list = await other.dispatch(
      "list_project_commands",
      { device, project },
      ["read"],
    );
    assert.equal(
      list.commands.some((c) => c.id === "cloudos_host_storage_audit"),
      false,
    );
    await assert.rejects(
      other.dispatch("run_project_command", other.request(), ["execute"]),
      /CLOUDOS_HOST_AUDIT_NOT_AUTHORIZED/,
    );
  }
  assert.equal(f.jobs.length, 0);
});

test(
  "host audit reports partial visibility without claiming full disk inventory, and blocks unhealthy services",
  { skip: process.platform === "win32" },
  async (t) => {
    const f = fixture(t);
    await f.dispatch("run_project_command", f.request(), ["execute"]);
    const command = f.jobs[0].args[3];
    const driver = String.raw`
import sys,socket,subprocess,types
socket.gethostname=lambda: 'google-vps1'
scenario=sys.argv[2]
def simulated(argv,**kwargs):
    if argv[0] == 'systemctl':
        return types.SimpleNamespace(returncode=1 if scenario == 'services' else 0,stdout='active\nactive\nactive\n')
    if argv[0] == 'du':
        return types.SimpleNamespace(returncode=1 if scenario == 'partial' else 0,stdout='1G\t/sample\n')
    return types.SimpleNamespace(returncode=0,stdout='Filesystem Size Used Avail Use% Mounted on\n')
subprocess.run=simulated
exec(sys.argv[1], {'__name__':'__main__'})
`;
    const simulate = (scenario) =>
      spawnSync("python3", ["-I", "-B", "-c", driver, command, scenario], {
        timeout: 10000,
        encoding: "utf8",
      });
    const healthy = simulate("healthy");
    assert.equal(healthy.status, 0, healthy.stderr);
    assert.match(healthy.stdout, /CLOUDOS_HOST_STORAGE_AUDIT=PASS/);
    const partial = simulate("partial");
    assert.equal(partial.status, 0, partial.stderr);
    assert.match(partial.stdout, /READ_ONLY_CHECK_HOST_DIRS=PARTIAL/);
    assert.match(partial.stdout, /CLOUDOS_HOST_STORAGE_AUDIT=PARTIAL/);
    assert.doesNotMatch(partial.stdout, /CLOUDOS_HOST_STORAGE_AUDIT=PASS/);
    const blocked = simulate("services");
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stdout, /READ_ONLY_CHECK_SERVICES=BLOCKED/);
    assert.match(blocked.stdout, /CLOUDOS_HOST_STORAGE_AUDIT=BLOCKED/);
  },
);
