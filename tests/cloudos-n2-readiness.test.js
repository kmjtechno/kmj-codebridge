import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDispatcher } from "../src/tools.js";
import { CLOUDOS_N2_READINESS_PYTHON } from "../src/cloudos-n2-readiness.js";

function fixture(
  t,
  device = "google-vps",
  project = "kmj-cloudos",
  writable = true,
) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-n2-readiness-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repo");
  fs.mkdirSync(root);
  const jobs = [];
  const config = {
    id: device,
    stateDir: temp,
    projects: [{ id: project, root, writable, gates: {}, commands: {} }],
  };
  const runner = {
    maxConcurrent: 1,
    run: (job) => {
      jobs.push(job);
      return { id: "n2-readonly-job", state: "queued" };
    },
  };
  const dispatch = createDispatcher(config, runner, () => ({
    features: ["read", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  return { dispatch, jobs, root, device, project };
}

const request = (
  device = "google-vps",
  project = "kmj-cloudos",
  extra = {},
) => ({
  device,
  project,
  command: "cloudos_n2_guest_readiness",
  variant: "check",
  requestKey: "readiness-n2-unit",
  ...extra,
});

test("N2 host readiness is a built-in read-only command with fixed argv", async (t) => {
  const f = fixture(t);
  const listing = await f.dispatch(
    "list_project_commands",
    {
      device: f.device,
      project: f.project,
    },
    ["read"],
  );
  const profile = listing.commands.find(
    (row) => row.id === "cloudos_n2_guest_readiness",
  );
  assert.ok(profile);
  assert.equal(profile.risk, "READ");
  assert.equal(profile.approvalRequired, false);
  assert.deepEqual(profile.variants, ["check"]);

  const result = await f.dispatch("run_project_command", request(), [
    "execute",
  ]);
  assert.equal(result.state, "queued");
  assert.equal(f.jobs.length, 1);
  const job = f.jobs[0];
  assert.equal(job.project, "kmj-cloudos");
  assert.equal(job.cwd, f.root);
  assert.equal(job.key, "readiness-n2-unit");
  assert.equal(job.command, "python3");
  assert.deepEqual(job.args, ["-I", "-B", "-c", CLOUDOS_N2_READINESS_PYTHON]);
  assert.equal(job.timeoutMs, 30000);
});

test("N2 host command refuses caller overrides", async (t) => {
  const f = fixture(t);
  for (const extra of [
    { variant: "install" },
    { variant: "start" },
    { variant: "apply" },
    { laneId: "other" },
    { expectedHead: "a".repeat(40) },
  ]) {
    await assert.rejects(
      f.dispatch("run_project_command", request(f.device, f.project, extra), [
        "execute",
      ]),
      /COMMAND_NOT_ALLOWED/,
    );
  }
  assert.equal(f.jobs.length, 0);
});

test("N2 host command is hidden and denied on wrong device/project/read-only checkout", async (t) => {
  for (const [device, project, writable] of [
    ["kmj-elite-cloudos", "kmj-cloudos", true],
    ["google-vps", "kmj-main-platform", true],
    ["google-vps", "kmj-cloudos", false],
  ]) {
    const f = fixture(t, device, project, writable);
    const listing = await f.dispatch(
      "list_project_commands",
      { device, project },
      ["read"],
    );
    assert.equal(
      listing.commands.some((c) => c.id === "cloudos_n2_guest_readiness"),
      false,
    );
    await assert.rejects(
      f.dispatch("run_project_command", request(device, project), ["execute"]),
      /CLOUDOS_N2_READINESS_NOT_AUTHORIZED|READ_ONLY_PROJECT/,
    );
    assert.equal(f.jobs.length, 0);
  }
});

test("N2 identity fails closed for wrong zone, missing zone and wrong machine", (t) => {
  const py = process.platform === "win32" ? "python" : "python3";
  const harness = [
    CLOUDOS_N2_READINESS_PYTHON,
    "def fake_meta(field):",
    "    return fields.get(field, 'UNVERIFIED')",
    "meta=fake_meta",
    "assert identity_matches() is True",
    "fields['zone']='projects/123/zones/us-central1-b'",
    "assert identity_matches() is False",
    "del fields['zone']",
    "assert identity_matches() is False",
    "fields['zone']='projects/123/zones/us-central1-a'",
    "fields['machine-type']='n2-standard-4'",
    "assert identity_matches() is False",
    "fields['machine-type']='n2-standard-2'",
    "fields['name']='other-instance'",
    "assert identity_matches() is False",
  ].join("\n");
  const source = "fields={'name':'instance-20260912-094732','machine-type':'n2-standard-2','zone':'projects/123/zones/us-central1-a'}\n" + harness;
  const checked = spawnSync(py, ["-I", "-B", "-c", source], {
    encoding: "utf8", timeout: 10000,
  });
  if (checked.error && checked.error.code === "ENOENT") {
    t.skip("Python runtime unavailable on this test host");
  } else {
    assert.equal(checked.status, 0, checked.stderr);
  }
});

test("Pinned Python inspector has valid syntax and no host mutation primitives", (t) => {
  assert.match(CLOUDOS_N2_READINESS_PYTHON, /google-vps1/);
  assert.match(CLOUDOS_N2_READINESS_PYTHON, /instance-20260912-094732/);
  assert.match(CLOUDOS_N2_READINESS_PYTHON, /fcntl\.ioctl/);
  assert.match(CLOUDOS_N2_READINESS_PYTHON, /ABI_12_USABLE/);
  assert.match(CLOUDOS_N2_READINESS_PYTHON, /NOT_APPROVED/);
  assert.doesNotMatch(
    CLOUDOS_N2_READINESS_PYTHON,
    /shell=True|os\.system\(|subprocess\.Popen\(|apt-get|virsh.*(?:start|create|destroy|undefine)/,
  );
  const py = process.platform === "win32" ? "python" : "python3";
  const checked = spawnSync(
    py,
    ["-I", "-B", "-c", "import ast,sys;ast.parse(sys.stdin.read())"],
    {
      input: CLOUDOS_N2_READINESS_PYTHON,
      encoding: "utf8",
      timeout: 10000,
    },
  );
  if (checked.error && checked.error.code === "ENOENT") {
    t.skip("Python runtime unavailable on this test host");
  } else {
    assert.equal(checked.status, 0, checked.stderr);
  }
});
