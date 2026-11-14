import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  AGENT_POLL_WAIT_CAP_MS,
  effectivePollWaitMs,
  startGateway,
} from "../src/gateway.js";
import { AGENT_REQUEST_TIMEOUT_MS } from "../src/agent.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("empty poll hold stays below the agent request timeout with margin", () => {
  assert.ok(AGENT_REQUEST_TIMEOUT_MS - AGENT_POLL_WAIT_CAP_MS >= 5000);
  assert.equal(effectivePollWaitMs(45000), AGENT_POLL_WAIT_CAP_MS);
  assert.equal(effectivePollWaitMs(120000), AGENT_POLL_WAIT_CAP_MS);
  assert.equal(effectivePollWaitMs(50), 50);
  assert.equal(effectivePollWaitMs(undefined), AGENT_POLL_WAIT_CAP_MS);
  assert.equal(effectivePollWaitMs(Number.NaN), AGENT_POLL_WAIT_CAP_MS);
  assert.equal(effectivePollWaitMs(0), AGENT_POLL_WAIT_CAP_MS);
});

test("default gateway returns an idle poll cleanly before the agent would abort", async (t) => {
  const agentToken = "agent-token-poll-wait-cap-0123456789abcdef";
  const gw = await startGateway({
    host: "127.0.0.1",
    port: 0,
    users: [
      {
        id: "u1",
        tenant: "t1",
        tokenHash: digest("user-token-poll-wait-cap-0123456789abcdef"),
        devices: {},
        permissions: ["read"],
      },
    ],
    agents: [{ id: "d1", tenant: "t1", tokenHash: digest(agentToken) }],
  });
  t.after(async () => gw.close());

  const started = Date.now();
  const response = await fetch(gw.url + "/agent/poll", {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentToken}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(AGENT_REQUEST_TIMEOUT_MS),
  });
  const elapsed = Date.now() - started;
  assert.equal(response.status, 200);
  assert.ok(
    elapsed >= AGENT_POLL_WAIT_CAP_MS - 500,
    `returned early: ${elapsed}ms`,
  );
  assert.ok(
    elapsed < AGENT_REQUEST_TIMEOUT_MS - 2000,
    `held too long: ${elapsed}ms`,
  );
});
