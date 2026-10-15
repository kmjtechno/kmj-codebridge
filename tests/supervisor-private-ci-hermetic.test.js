import test from "node:test";
import assert from "node:assert/strict";
import { createSupervisorHandler } from "../src/supervisor.js";

// Never read live /var/lib evidence in CI: exercise only the fixed supervisor
// control flow and verify an arbitrary ref cannot become a systemd request.
test("private payment QA status is hermetic and start is deferred", async () => {
  const started = [];
  let evidenceReads = 0;
  const handle = createSupervisorHandler({
    run: () => "LoadState=loaded\nActiveState=inactive\n",
    start: (service) => started.push(service),
    lstat: () => {
      evidenceReads++;
      const error = new Error("Isolated test evidence unavailable");
      error.code = "ENOENT";
      throw error;
    },
  });

  const status = await handle({ op: "private_pr419_ci_status" });
  assert.equal(status.response.service.installed, true);
  assert.equal(status.response.last, null);
  assert.equal(evidenceReads, 1);

  const response = await handle({ op: "private_pr419_ci_start" });
  assert.deepEqual(response.response, {
    accepted: true,
    target: "private-pr419",
  });
  assert.deepEqual(started, []);
  response.afterSend();
  assert.deepEqual(started, ["kmj-codebridge-private-pr419-ci.service"]);

  for (const extra of [
    { sha: "a".repeat(40) },
    { command: "bash" },
    { path: "/etc/shadow" },
  ]) {
    await assert.rejects(
      handle({ op: "private_pr419_ci_start", ...extra }),
      /INVALID_SUPERVISOR_REQUEST/,
    );
  }
});

test("private payment QA start fails closed for missing and busy units", async () => {
  await assert.rejects(
    createSupervisorHandler({
      run: () => "LoadState=not-found\nActiveState=inactive\n",
    })({ op: "private_pr419_ci_start" }),
    /SUPERVISOR_PRIVATE_CI_UNAVAILABLE/,
  );
  await assert.rejects(
    createSupervisorHandler({
      run: () => "LoadState=loaded\nActiveState=active\n",
    })({ op: "private_pr419_ci_start" }),
    /SUPERVISOR_PRIVATE_CI_BUSY/,
  );
});
