import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditFreeFirst } from "../src/free-first.js";
import { JobRunner } from "../src/jobs.js";
import { createDispatcher } from "../src/tools.js";

const wf = (name, content) => ({
  path: `.github/workflows/${name}`,
  content,
});
const ids = (r) => r.findings.map((f) => f.id);

const costly = `name: costly
on:
  push:
  pull_request:
  schedule:
    - cron: '*/5 * * * *'
jobs:
  build:
    runs-on: macos-latest
    steps:
      - run: echo hi
        env:
          OPENAI_API_KEY: \${{ secrets.OPENAI_API_KEY }}
  win:
    runs-on: windows-latest
    timeout-minutes: 20
    steps:
      - run: echo hi
  lin:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - run: echo hi
`;

test("flags the settings that can burn paid minutes, with a free alternative each", () => {
  const r = auditFreeFirst([wf("costly.yml", costly)]);
  const got = new Set(ids(r));
  for (const id of [
    "HOSTED_RUNNER",
    "FREQUENT_SCHEDULE",
    "NO_TIMEOUT",
    "NO_CONCURRENCY",
    "PAID_SERVICE_CREDENTIAL",
  ])
    assert.ok(got.has(id), `${id} missing`);
  const byId = (id) => r.findings.filter((f) => f.id === id);
  assert.equal(byId("HOSTED_RUNNER").length, 3);
  assert.deepEqual(
    byId("HOSTED_RUNNER")
      .map((f) => f.severity)
      .sort(),
    ["high", "low", "medium"],
  );
  assert.equal(byId("FREQUENT_SCHEDULE")[0].severity, "high");
  // Only the job without timeout-minutes is reported.
  assert.deepEqual(
    byId("NO_TIMEOUT").map((f) => f.evidence),
    ["build:"],
  );
  assert.equal(r.spendRisk, "high");
  for (const f of r.findings.filter((x) => x.severity !== "info"))
    assert.ok(f.freeAlternative.length > 20, `${f.id} has no alternative`);
  assert.match(r.advisory, /cannot see your billing plan/);
});

test("a tidy self-hosted workflow has no spend finding", () => {
  const r = auditFreeFirst([
    wf(
      "ok.yml",
      `name: ok
on:
  pull_request:
concurrency:
  group: ci-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: [self-hosted, linux]
    timeout-minutes: 15
    steps:
      - run: npm test
`,
    ),
  ]);
  assert.deepEqual(ids(r), ["SELF_HOSTED"]);
  assert.equal(r.summary.high + r.summary.medium + r.summary.low, 0);
  assert.equal(r.spendRisk, "low");
});

test("schedule frequency is judged, not just present", () => {
  const sched = (cron) =>
    auditFreeFirst([
      wf(
        "s.yml",
        `on:\n  schedule:\n    - cron: '${cron}'\njobs:\n  j:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n`,
      ),
    ]).findings.filter((f) => f.id === "FREQUENT_SCHEDULE");
  assert.equal(sched("* * * * *")[0].severity, "high");
  assert.equal(sched("*/15 * * * *")[0].severity, "high");
  assert.equal(sched("*/30 * * * *")[0].severity, "medium");
  assert.equal(sched("0 3 * * *").length, 0);
  assert.equal(sched("0 * * * *").length, 0);
});

test("a frequent schedule on self-hosted runners is information, not a spend risk", () => {
  const r = auditFreeFirst([
    wf(
      "poll.yml",
      `on:\n  schedule:\n    - cron: '*/5 * * * *'\njobs:\n  j:\n    runs-on: self-hosted\n    timeout-minutes: 5\n`,
    ),
  ]);
  const f = r.findings.find((x) => x.id === "FREQUENT_SCHEDULE");
  assert.equal(f.severity, "info");
  assert.match(f.message, /no hosted minutes/);
  assert.equal(r.spendRisk, "low");
  // Mixed: one hosted job keeps it a real risk.
  const mixed = auditFreeFirst([
    wf(
      "mixed.yml",
      `on:\n  schedule:\n    - cron: '*/5 * * * *'\njobs:\n  a:\n    runs-on: self-hosted\n    timeout-minutes: 5\n  b:\n    runs-on: ubuntu-latest\n    timeout-minutes: 5\n`,
    ),
  ]);
  assert.equal(
    mixed.findings.find((x) => x.id === "FREQUENT_SCHEDULE").severity,
    "high",
  );
});

test("an unbounded matrix is flagged, a bounded one is not", () => {
  const job = (extra) =>
    auditFreeFirst([
      wf(
        "m.yml",
        `on:\n  pull_request:\nconcurrency:\n  group: x\n  cancel-in-progress: true\njobs:\n  t:\n    runs-on: self-hosted\n    timeout-minutes: 5\n    strategy:\n${extra}      matrix:\n        os: [a, b, c]\n`,
      ),
    ]).findings.filter((f) => f.id === "MATRIX_NO_MAX_PARALLEL");
  const open = job("");
  assert.equal(open.length, 1);
  assert.match(open[0].message, /your own machine/);
  assert.equal(job("      max-parallel: 1\n").length, 0);
});

test("crafted long lines cannot stall the scan (ReDoS guard)", () => {
  const evil = [
    `on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: ${" ".repeat(200000)}x\n`,
    `jobs:\n  a:\n    runs-on: ${" ".repeat(150000)}x\n`,
    `x: ${"STRIPE_".repeat(40000)}\n`,
    `on:\n  schedule:\n    - cron: '${" ".repeat(150000)}1'\n`,
  ];
  for (const content of evil) {
    const started = Date.now();
    const r = auditFreeFirst([wf("evil.yml", content)]);
    assert.ok(Date.now() - started < 1500, "scan took too long");
    assert.ok(r.longLinesSkipped >= 1);
  }
  const circle = auditFreeFirst([
    {
      path: ".circleci/config.yml",
      content: `  resource_class: ${" ".repeat(150000)}x\n`,
    },
  ]);
  assert.equal(circle.longLinesSkipped, 1);
  // Ordinary lines around a skipped one are still audited.
  const mixed = auditFreeFirst([
    wf(
      "mixed.yml",
      `jobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${"x".repeat(2500)}\n    timeout-minutes: 5\n`,
    ),
  ]);
  assert.equal(mixed.longLinesSkipped, 1);
  assert.ok(mixed.findings.some((f) => f.id === "HOSTED_RUNNER"));
  assert.equal(
    auditFreeFirst([wf("ok.yml", "on: push\n")]).longLinesSkipped,
    0,
  );
});

test("concurrency without cancel-in-progress is reported once", () => {
  const r = auditFreeFirst([
    wf(
      "c.yml",
      `on:\n  push:\nconcurrency:\n  group: x\njobs:\n  j:\n    runs-on: self-hosted\n    timeout-minutes: 5\n`,
    ),
  ]);
  assert.ok(ids(r).includes("NO_CANCEL_IN_PROGRESS"));
  assert.ok(!ids(r).includes("NO_CONCURRENCY"));
});

test("CircleCI premium classes and executors are flagged, small/medium are not", () => {
  const r = auditFreeFirst([
    {
      path: ".circleci/config.yml",
      content: `jobs:\n  a:\n    resource_class: small\n  b:\n    resource_class: medium\n  c:\n    resource_class: xlarge\n  d:\n    macos:\n      xcode: 15\n`,
    },
  ]);
  assert.deepEqual(r.findings.map((f) => f.id).sort(), [
    "PREMIUM_EXECUTOR",
    "PREMIUM_RESOURCE_CLASS",
  ]);
  assert.match(
    r.findings.find((f) => f.id === "PREMIUM_RESOURCE_CLASS").message,
    /xlarge/,
  );
});

test("non-CI files and bad input are ignored safely", () => {
  assert.deepEqual(
    auditFreeFirst(
      [
        { path: "README.md", content: "runs-on: macos-latest" },
        { path: ".github/workflows/x.yml", content: 42 },
        null,
      ].filter(Boolean),
    ).findings,
    [],
  );
  assert.throws(() => auditFreeFirst("nope"), TypeError);
});

function project(t, { circle = null } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-free-"));
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    costly.replace(
      "OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}",
      "API_TOKEN: ghp_" + "a".repeat(36),
    ),
  );
  fs.writeFileSync(
    path.join(root, ".env"),
    "OPENAI_API_KEY=sk-should-never-appear\n",
  );
  if (circle) {
    fs.mkdirSync(path.join(root, ".circleci"));
    fs.writeFileSync(path.join(root, ".circleci", "config.yml"), circle);
  }
  const runner = new JobRunner(path.join(base, "state", "jobs"), {
    maxConcurrent: 1,
  });
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    runner,
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  return dispatch;
}

const scope = { device: "d1", project: "p1" };

test("free_first_audit tool reads project config, is read-only and redacts", async (t) => {
  const dispatch = project(t, {
    circle: "jobs:\n  big:\n    resource_class: 2xlarge\n",
  });
  const r = await dispatch("free_first_audit", scope, ["read"]);
  assert.equal(r.device, "d1");
  assert.equal(r.project, "p1");
  assert.deepEqual(r.checkedFiles.map((f) => f.path).sort(), [
    ".circleci/config.yml",
    ".github/workflows/ci.yml",
  ]);
  assert.ok(r.findings.some((f) => f.id === "HOSTED_RUNNER"));
  assert.ok(r.findings.some((f) => f.id === "PREMIUM_RESOURCE_CLASS"));
  const text = JSON.stringify(r);
  assert.ok(
    !text.includes("sk-should-never-appear"),
    "protected files are never read",
  );
  assert.ok(!text.includes("a".repeat(36)), "token-shaped text is redacted");
  await assert.rejects(
    dispatch("free_first_audit", scope, ["write"]),
    /ACCESS_DENIED/,
  );
  await assert.rejects(
    dispatch("free_first_audit", { ...scope, project: "p2" }, ["read"]),
    /PROJECT_NOT_FOUND/,
  );
});

test("free_first_audit on a project with no CI config reports nothing, not an error", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cb-free-empty-"));
  const root = path.join(base, "project");
  fs.mkdirSync(root);
  const runner = new JobRunner(path.join(base, "state", "jobs"), {
    maxConcurrent: 1,
  });
  t.after(async () => {
    await runner.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: path.join(base, "state"),
      projects: [{ id: "p1", root, writable: false, gates: {}, commands: {} }],
    },
    runner,
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  const r = await dispatch("free_first_audit", scope, ["read"]);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.checkedFiles, []);
  assert.equal(r.spendRisk, "low");
});
