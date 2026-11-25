import test from "node:test";
import assert from "node:assert/strict";
import { createIsolatedTerminalCore } from "../src/isolated-terminal-core.js";
import {
  createPinnedDockerInvoker,
  validateDockerInvocation,
} from "../src/pinned-docker-invoker.js";

const id = "b".repeat(64);
const imageId = "sha256:" + "a".repeat(64);
const limits = { timeoutMs: 15000, maxOutputBytes: 4096 };

test("pinned adapter admits only the isolated core's fixed Docker argv", async () => {
  const calls = [];
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    invokeDocker: async (args, options) => {
      validateDockerInvocation(args, options);
      calls.push(args);
      return { exitCode: 0, stdout: id };
    },
  });
  await terminal.execute("printf 'hello'; pwd");
  assert.equal(calls.length, 3);

  const create = calls[0];
  for (const args of [
    [...create.slice(0, 3), "--privileged", ...create.slice(3)],
    create.map((arg) => (arg === "--network=none" ? "--network=host" : arg)),
    create.map((arg) => (arg === imageId ? "ubuntu:latest" : arg)),
    ["start", "--attach", "someone-elses-container"],
    ["rm", "--force", id, id],
    ["run", "--privileged", "ubuntu"],
    ["--host", "tcp://example.invalid:2375", "info"],
  ]) {
    assert.throws(
      () => validateDockerInvocation(args, limits),
      /TERMINAL_DOCKER_INVOCATION_DENIED/,
    );
  }
});

test("adapter rejects unbounded process output or runtime", () => {
  const args = ["start", "--attach", id];
  for (const invalid of [
    { timeoutMs: 120001, maxOutputBytes: 4096 },
    { timeoutMs: 1000, maxOutputBytes: 32769 },
    { timeoutMs: 0, maxOutputBytes: 4096 },
    { timeoutMs: 1000, maxOutputBytes: 0 },
  ]) {
    assert.throws(
      () => validateDockerInvocation(args, invalid),
      /TERMINAL_DOCKER_INVOCATION_DENIED/,
    );
  }
});

test("adapter requires trusted local opt-in and rejects remote endpoints", async () => {
  await assert.rejects(
    createPinnedDockerInvoker(),
    /TERMINAL_OWNER_OPT_IN_REQUIRED/,
  );
  for (const endpoint of [
    "tcp://127.0.0.1:2375",
    "ssh://remote",
    "npipe:////remote/pipe/docker_engine",
  ]) {
    await assert.rejects(
      createPinnedDockerInvoker({ enabled: true, endpoint }),
      /TERMINAL_LOCAL_DAEMON_REQUIRED/,
    );
  }
});

test("cancellation before creation never invokes the backend", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    invokeDocker: async () => {
      calls++;
    },
  });
  await assert.rejects(
    terminal.execute("true", { signal: controller.signal }),
    /TERMINAL_EXECUTION_CANCELLED/,
  );
  assert.equal(calls, 0);
});

test("cancellation during creation skips start but removes the exact ID", async () => {
  const controller = new AbortController();
  const calls = [];
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    invokeDocker: async (args, options) => {
      validateDockerInvocation(args, options);
      assert.equal(options.signal, undefined);
      calls.push(args[0]);
      if (args[0] === "create") controller.abort();
      if (args[0] === "rm") assert.equal(args[2], id);
      return { exitCode: 0, stdout: id };
    },
  });
  await assert.rejects(
    terminal.execute("true", { signal: controller.signal }),
    /TERMINAL_EXECUTION_CANCELLED/,
  );
  assert.deepEqual(calls, ["create", "rm"]);
});

test("cancellation during start cannot cancel cleanup or hide cleanup failure", async () => {
  const controller = new AbortController();
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    invokeDocker: async (args, options) => {
      validateDockerInvocation(args, options);
      if (args[0] === "start") {
        assert.equal(options.signal, controller.signal);
        controller.abort();
        throw new Error("aborted");
      }
      assert.equal(options.signal, undefined);
      return { exitCode: args[0] === "rm" ? 1 : 0, stdout: id };
    },
  });
  await assert.rejects(
    terminal.execute("true", { signal: controller.signal }),
    /TERMINAL_CLEANUP_UNVERIFIED/,
  );
});

test("Docker cleanup does not accept an abort signal", () => {
  assert.throws(
    () =>
      validateDockerInvocation(["rm", "--force", id], {
        ...limits,
        signal: new AbortController().signal,
      }),
    /TERMINAL_DOCKER_INVOCATION_DENIED/,
  );
});
