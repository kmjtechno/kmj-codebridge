import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createDispatcher } from "../src/tools.js";

test("captured job status reuses browser QA receipt hash verifier fail-closed", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-browser-receipt-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, "root");
  const stateDir = path.join(home, "state");
  fs.mkdirSync(root);
  fs.mkdirSync(stateDir);
  const jobId = "browser-fixture-job";
  const requestKey = "browser-receipt-test";
  const browserJob = {
    id: jobId,
    gate: "browser-qa:kmj-public",
    state: "succeeded",
    project: "kmj-main-platform",
    output: "BROWSER_QA=PASS",
  };
  const runner = {
    maxConcurrent: 1,
    jobs: new Map([[jobId, { key: requestKey }]]),
    archive: new Map(),
    peekState: () => browserJob.state,
    get: () => ({ ...browserJob }),
  };
  const config = {
    id: "d1",
    stateDir,
    projects: [
      {
        id: "kmj-main-platform",
        root,
        writable: true,
        gates: {},
        commands: {},
      },
    ],
  };
  const dispatch = createDispatcher(config, runner, () => ({
    features: ["read", "write", "execute"],
    limits: { concurrent_jobs: 1 },
  }));
  const receiptKey = createHash("sha256")
    .update("kmj-main-platform:" + requestKey)
    .digest("hex");
  const dir = path.join(stateDir, "browser-qa", receiptKey);
  fs.mkdirSync(dir, { recursive: true });
  const samples = [];
  for (const viewport of ["desktop", "tablet", "mobile"]) {
    for (const route of ["home", "products", "login"]) {
      const screenshot = viewport + "-" + route + ".png";
      const bytes = Buffer.alloc(128, samples.length + 1);
      fs.writeFileSync(path.join(dir, screenshot), bytes);
      samples.push({
        viewport,
        path: route === "home" ? "/" : "/" + route,
        screenshot,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        httpStatus: 200,
        brokenImages: 0,
        overflowPx: 0,
        exceptions: 0,
        failures: [],
      });
    }
  }
  fs.writeFileSync(
    path.join(dir, "receipt.json"),
    JSON.stringify({
      schema: "kmj-browser-v1",
      target: "kmj_public",
      verdict: "PASS",
      checkedAt: "2026-10-17T00:00:00Z",
      samples,
    }),
  );
  const args = {
    device: "d1",
    project: "kmj-main-platform",
    job: jobId,
  };
  const done = await dispatch("get_job_status", args, ["read"]);
  assert.equal(done.state, "succeeded");
  assert.equal(done.browserQaReceipt.verified, true);
  assert.equal(done.browserQaReceipt.verdict, "PASS");
  assert.equal(done.browserQaReceipt.samples.length, 9);
  assert.equal(
    done.browserQaReceipt.samples[0].screenshotSha256,
    samples[0].sha256,
  );
  assert.equal(JSON.stringify(done).includes(dir), false);

  fs.writeFileSync(path.join(dir, samples[0].screenshot), Buffer.alloc(128));
  const bad = await dispatch("get_job_status", args, ["read"]);
  assert.equal(bad.state, "succeeded");
  assert.equal(bad.browserQaReceipt.verified, false);
  assert.equal(bad.browserQaReceipt.error, "BROWSER_QA_RECEIPT_INVALID");
  assert.equal(bad.browserQaReceipt.verdict, undefined);

  browserJob.gate = "command:runtime_inspect:node_version:inspect";
  const normal = await dispatch("get_job_status", args, ["read"]);
  assert.equal(normal.browserQaReceipt, undefined);
  await assert.rejects(
    dispatch("get_job_status", args, ["execute"]),
    /ACCESS_DENIED/,
  );
});
