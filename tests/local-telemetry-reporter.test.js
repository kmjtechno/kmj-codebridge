import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readQueue,
  readOllama,
  reportOnce,
} from "../scripts/report-main-platform-telemetry.mjs";

test("device journal only counts scoped Autopilot tasks", () => {
  const root = mkdtempSync(join(tmpdir(), "cb-telemetry-"));
  try {
    mkdirSync(join(root, "autopilot"));
    writeFileSync(
      join(root, "autopilot", "state.json"),
      JSON.stringify({
        version: 2,
        missions: [],
        tasks: [
          { project: "project-a", state: "queued" },
          { project: "project-a", state: "running" },
          { project: "project-b", state: "waiting" },
        ],
      }),
    );
    assert.deepEqual(readQueue(root, "project-a"), {
      queued: 1,
      running: 1,
      waiting: 0,
    });
    assert.deepEqual(readQueue(root, "project-b"), {
      queued: 0,
      running: 0,
      waiting: 1,
    });
    writeFileSync(join(root, "autopilot", "state.json"), "not-json");
    assert.equal(readQueue(root, "project-a"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Ollama probe only queries exact device loopback endpoints", async () => {
  const seen = [];
  const result = await readOllama(async (url) => {
    seen.push(url);
    return new Response(
      JSON.stringify({
        models: [{ name: "qwen3:4b" }, { name: "unsafe key=secret" }],
      }),
      { status: 200 },
    );
  });
  assert.deepEqual(
    seen,
    [11434, 11435, 11436].map(
      (port) => "http://127.0.0.1:" + port + "/api/tags",
    ),
  );
  assert.deepEqual(result, { reachable: true, models: ["qwen3:4b"] });
});

test("payload contains no token; model probe never calls a cloud provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "cb-telemetry-"));
  try {
    const file = join(root, "agent.json");
    const token = "A".repeat(64);
    writeFileSync(
      file,
      JSON.stringify({
        gateway: "https://kmjtechno.com/",
        id: "device-one",
        tenant: "tenant-a",
        token,
        stateDir: root,
        projects: [{ id: "project-a" }],
      }),
    );
    const calls = [];
    const result = await reportOnce(file, async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/api/tags"))
        throw new Error("Ollama not installed on this host");
      return { status: 202 };
    });
    assert.equal(result.accepted, true);
    assert.equal(result.queueSampled, false);
    assert.equal(calls.length, 4);
    assert.equal(
      calls[3].url,
      "https://kmjtechno.com/api/codebridge/v1/telemetry",
    );
    assert.equal(calls[3].options.headers.Authorization, "Bearer " + token);
    const body = JSON.parse(calls[3].options.body);
    assert.deepEqual(body, {
      project_id: "project-a",
      ollama: { reachable: false, models: [] },
    });
    assert.ok(!calls[3].options.body.includes(token));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
