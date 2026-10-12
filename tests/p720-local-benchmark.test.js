import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  TARGETS,
  nanosToMs,
  inferenceRecord,
  benchmarkTarget,
  localJson,
} from "../scripts/p720-local-benchmark.mjs";

test("offline P720 cold versus warm benchmark reports actual Ollama counters", async () => {
  const calls = [];
  let count = 0;
  const fake = async (port, endpoint, payload) => {
    calls.push({ port, endpoint, payload });
    if (endpoint === "/api/tags") return { models: [{ name: "qwen3:4b" }] };
    if (endpoint === "/api/ps")
      return {
        models:
          count === 0 ? [] : [{ name: "qwen3:4b", size_vram: 2800000000 }],
      };
    if (payload.prompt === "") return { done: true };
    count++;
    return {
      done: true,
      response: "function add(a, b) { return a + b; }",
      total_duration: [5000000000, 4400000000, 1500000000][count - 1],
      load_duration: [3000000000, 2000000000, 0][count - 1],
      eval_count: 30,
      eval_duration: 1000000000,
    };
  };
  const result = await benchmarkTarget(
    { port: 11436, model: "qwen3:4b" },
    fake,
  );
  assert.equal(result.state, "MEASURED");
  assert.equal(result.cold.totalMs, 5000);
  assert.equal(result.warm.totalMs, 1500);
  assert.equal(result.warmLatencyChangePercent, -70);
  assert.equal(result.allCodingSmokesPass, true);
  assert.equal(result.observedVramBytes, 2800000000);
  const generate = calls.filter((call) => call.endpoint === "/api/generate");
  assert.deepEqual(
    generate.map((call) => call.payload.keep_alive),
    [0, "30s", "30s", 0],
  );
  assert.ok(generate.slice(0, 3).every((call) => call.payload.think === false));
  assert.ok(generate.every((call) => call.port === 11436));
  assert.equal(generate.at(-1).payload.prompt, "");
});

test("absent model does not request generation or unloading", async () => {
  const calls = [];
  const result = await benchmarkTarget(
    { port: 11434, model: "qwen3:8b", optional: true },
    async (port, endpoint) => {
      calls.push({ port, endpoint });
      return { models: [] };
    },
  );
  assert.deepEqual(result, {
    model: "qwen3:8b",
    port: 11434,
    state: "NOT_INSTALLED",
    optional: true,
  });
  assert.deepEqual(calls, [{ port: 11434, endpoint: "/api/tags" }]);
});

test("cold benchmark cannot evict a preloaded model belonging to Claude", async () => {
  const calls = [];
  const result = await benchmarkTarget(
    { port: 11435, model: "qwen2.5-coder:7b" },
    async (_port, endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === "/api/tags")
        return { models: [{ name: "qwen2.5-coder:7b" }] };
      if (endpoint === "/api/ps")
        return {
          models: [{ name: "qwen2.5-coder:7b", size_vram: 4600000000 }],
        };
      throw Error("UNEXPECTED_GENERATE_OR_EVICTION");
    },
  );
  assert.deepEqual(result, {
    model: "qwen2.5-coder:7b",
    port: 11435,
    state: "BLOCKED",
    error: "BENCH_OTHER_WORKLOAD_ACTIVE",
  });
  assert.deepEqual(
    calls.map((call) => call.endpoint),
    ["/api/tags", "/api/ps"],
  );
});

test("uncertain baseline never requests generation or unload", async () => {
  const calls = [];
  const result = await benchmarkTarget(
    { port: 11436, model: "qwen3:4b" },
    async (_port, endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === "/api/tags") return { models: [{ name: "qwen3:4b" }] };
      if (endpoint === "/api/ps") return { unexpected: true };
      throw Error("UNEXPECTED_GENERATE_OR_EVICTION");
    },
  );
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.error, "BENCH_BASELINE_UNAVAILABLE");
  assert.deepEqual(
    calls.map((call) => call.endpoint),
    ["/api/tags", "/api/ps"],
  );
});

test("failed or thinking-only model output is never a reported speed gain", async () => {
  const calls = [];
  const result = await benchmarkTarget(
    { port: 11435, model: "qwen2.5-coder:7b" },
    async (_port, endpoint, body) => {
      calls.push({ endpoint, body });
      if (endpoint === "/api/tags")
        return { models: [{ name: "qwen2.5-coder:7b" }] };
      if (endpoint === "/api/ps") return { models: [] };
      return body.prompt === ""
        ? { done: true }
        : { done: true, response: " ", thinking: "hidden" };
    },
  );
  assert.equal(result.state, "BLOCKED");
  assert.equal(result.error, "BENCH_NO_VISIBLE_OUTPUT");
  assert.equal(calls.at(-1).body.keep_alive, 0);
});

test("timing parsing and loopback port allowlist fail closed", async () => {
  assert.equal(nanosToMs(-1), null);
  assert.equal(nanosToMs("100"), null);
  assert.equal(nanosToMs(1500000), 2);
  assert.throws(
    () => inferenceRecord({ done: true, response: "", eval_count: 33 }),
    /BENCH_NO_VISIBLE_OUTPUT/,
  );
  assert.throws(() => localJson(4444, "/api/tags"), /BENCH_PORT_NOT_APPROVED/);
  assert.deepEqual(
    TARGETS.map((t) => t.port),
    [11435, 11436, 11434],
  );
});

test("benchmark never calls unverified timing or incorrect code a success", async () => {
  let call = 0;
  const request = async (_port, endpoint, body) => {
    if (endpoint === "/api/tags")
      return { models: [{ name: "qwen2.5-coder:7b" }] };
    if (endpoint === "/api/ps") return { models: [] };
    if (body.prompt === "") return { done: true };
    call++;
    return {
      done: true,
      response: "This did not return the requested function.",
      total_duration: 1100000000,
      eval_count: 10,
      eval_duration: 1000000000,
    };
  };
  const result = await benchmarkTarget(
    { port: 11435, model: "qwen2.5-coder:7b" },
    request,
  );
  assert.equal(call, 3);
  assert.equal(result.state, "INVALID_CODING_OUTPUT");
  assert.equal(result.allCodingSmokesPass, false);
  assert.equal(result.warmLatencyChangePercent, null);

  const missingTiming = await benchmarkTarget(
    { port: 11435, model: "qwen2.5-coder:7b" },
    async (_port, endpoint, body) => {
      if (endpoint === "/api/tags")
        return { models: [{ name: "qwen2.5-coder:7b" }] };
      if (endpoint === "/api/ps") return { models: [] };
      if (body.prompt === "") return { done: true };
      return { done: true, response: "function add(a, b) {return a+b;}" };
    },
  );
  assert.equal(missingTiming.state, "INCOMPLETE_TIMING");
  assert.equal(missingTiming.warmLatencyChangePercent, null);
});

test("benchmark never labels absent generation counters as measured speed", async () => {
  const result = await benchmarkTarget(
    { port: 11436, model: "qwen3:4b" },
    async (_port, endpoint, body) => {
      if (endpoint === "/api/tags") return { models: [{ name: "qwen3:4b" }] };
      if (endpoint === "/api/ps") return { models: [] };
      if (body.prompt === "") return { done: true };
      return {
        done: true,
        response: "function add(a, b) { return a + b; }",
        total_duration: 1400000000,
        load_duration: 300000000,
        // Explicitly no eval_duration or eval_count.
      };
    },
  );
  assert.equal(result.state, "INCOMPLETE_TIMING");
  assert.equal(result.allCodingSmokesPass, true);
  assert.equal(result.warmLatencyChangePercent, null);
  assert.equal(result.cold.tokensPerSecond, null);
  assert.equal(result.warm.generatedTokens, null);
});

test("benchmark rejects zero-generation telemetry instead of false speed gains", async () => {
  const result = await benchmarkTarget(
    { port: 11435, model: "qwen2.5-coder:7b" },
    async (_port, endpoint, body) => {
      if (endpoint === "/api/tags")
        return { models: [{ name: "qwen2.5-coder:7b" }] };
      if (endpoint === "/api/ps") return { models: [] };
      if (body.prompt === "") return { done: true };
      return {
        done: true,
        response: "function add(a, b) { return a + b; }",
        total_duration: 1800000000,
        load_duration: 1000000000,
        eval_count: 0,
        eval_duration: 100000000,
      };
    },
  );
  assert.equal(result.state, "INCOMPLETE_TIMING");
  assert.equal(result.allCodingSmokesPass, true);
  assert.equal(result.warmLatencyChangePercent, null);
});

test(
  "P720 isolated benchmark Git wrapper handles real Windows progress stderr",
  { skip: process.platform !== "win32" },
  (t) => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "p720-bench-git-"));
    t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
    const bare = path.join(temp, "remote.git");
    const writer = path.join(temp, "writer");
    const consumer = path.join(temp, "consumer");
    const git = (args) => {
      const result = spawnSync("git", args, {
        shell: false,
        windowsHide: true,
        timeout: 15000,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(["init", "--bare", "-b", "main", bare]);
    git(["init", "-b", "main", writer]);
    const commitArgs = [
      "-C",
      writer,
      "-c",
      "user.name=CI",
      "-c",
      "user.email=ci@example.invalid",
      "commit",
      "--allow-empty",
    ];
    git([...commitArgs, "-m", "initial"]);
    git(["-C", writer, "remote", "add", "origin", bare]);
    git(["-C", writer, "push", "-u", "origin", "main"]);
    git(["clone", "--branch", "main", bare, consumer]);
    git([...commitArgs, "-m", "second"]);
    git(["-C", writer, "push", "origin", "main"]);

    const source = fs.readFileSync(
      path.resolve("scripts/p720-isolated-benchmark.ps1"),
      "utf8",
    );
    const match = source.match(
      /function Invoke-TrustedGit\(\[string\[\]\]\$GitArguments\) \{[\s\S]*?\n\}/,
    );
    assert.ok(match, "the audited benchmark Git wrapper must exist");
    const escapedRepo = consumer.replaceAll("'", "''");
    const expected = git(["-C", writer, "rev-parse", "HEAD"]);
    const code = [
      "$ErrorActionPreference = 'Stop'",
      `$repo = '${escapedRepo}'`,
      `$expected = '${expected}'`,
      match[0],
      "$null = Invoke-TrustedGit -GitArguments @('fetch', '--no-tags', 'origin', 'main')",
      "$actual = [string]((Invoke-TrustedGit -GitArguments @('rev-parse', '--verify', 'FETCH_HEAD')) | Select-Object -First 1)",
      "if ($actual -cne $expected) { throw 'FETCH_HEAD_MISMATCH' }",
      "try { $null = Invoke-TrustedGit -GitArguments @('rev-parse', '--verify', 'nonexistent-ref'); throw 'NONZERO_EXIT_ACCEPTED' } catch {",
      "  if ($_.Exception.Message -cne 'GIT_PREFLIGHT_OR_COMMAND_FAILED') { throw }",
      "}",
      "if ($ErrorActionPreference -cne 'Stop') { throw 'ERROR_PREFERENCE_NOT_RESTORED' }",
      "Write-Output 'BENCH_GIT_STDERR_HANDLED=PASS'",
    ].join("\n");
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", code],
      { shell: false, windowsHide: true, timeout: 30000, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /BENCH_GIT_STDERR_HANDLED=PASS/);
  },
);
