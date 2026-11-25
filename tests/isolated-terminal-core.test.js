import test from "node:test";
import assert from "node:assert/strict";
import { createIsolatedTerminalCore } from "../src/isolated-terminal-core.js";

const imageId = "sha256:" + "a".repeat(64);
const containerId = "b".repeat(64);

test("terminal requires explicit local opt-in and immutable image", () => {
  assert.throws(
    () => createIsolatedTerminalCore({ imageId }),
    /TERMINAL_OWNER_OPT_IN_REQUIRED/,
  );
  assert.throws(
    () =>
      createIsolatedTerminalCore({
        enabled: true,
        imageId: "ubuntu:latest",
        invokeDocker: async () => ({}),
      }),
    /TERMINAL_PINNED_IMAGE_REQUIRED/,
  );
});

test("arbitrary command text is only a container argument", async () => {
  const calls = [];
  const command = "printf 'hello'; pwd";
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    invokeDocker: async (args, limits) => {
      calls.push({ args, limits });
      return { exitCode: 0, stdout: containerId };
    },
  });
  const receipt = await terminal.execute(command);
  const args = calls[0].args;
  assert.deepEqual(args.slice(-4), [
    "--entrypoint=/bin/sh",
    imageId,
    "-c",
    command,
  ]);
  for (const flag of [
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65532:65532",
    "--pids-limit=128",
    "--memory=1g",
    "--cpus=2",
  ]) {
    assert.ok(args.includes(flag));
  }
  for (const flag of ["--privileged", "--mount", "-v", "--volume"]) {
    assert.ok(!args.includes(flag));
  }
  assert.deepEqual(calls[1].args, ["start", "--attach", containerId]);
  assert.deepEqual(calls[2].args, ["rm", "--force", containerId]);
  assert.equal(calls[1].limits.timeoutMs, 120000);
  assert.equal(receipt.executionSucceeded, true);
  assert.equal(receipt.projectWorkspaceMounted, false);
});

test("timeout or backend failure still cleans the exact container", async () => {
  const calls = [];
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    invokeDocker: async (args) => {
      calls.push(args);
      if (args[0] === "start") throw new Error("timeout");
      return { exitCode: 0, stdout: containerId };
    },
  });
  await assert.rejects(terminal.execute("sleep 10"), /EXECUTION_UNVERIFIED/);
  assert.deepEqual(calls.at(-1), ["rm", "--force", containerId]);
});

test("cleanup denial never returns a successful receipt", async () => {
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    invokeDocker: async (args) => ({
      exitCode: args[0] === "rm" ? 1 : 0,
      stdout: containerId,
    }),
  });
  await assert.rejects(terminal.execute("true"), /CLEANUP_UNVERIFIED/);
});

test("invalid identity or invalid command cannot start a container", async () => {
  const calls = [];
  const terminal = createIsolatedTerminalCore({
    enabled: true,
    imageId,
    invokeDocker: async (args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "unverified-id" };
    },
  });
  await assert.rejects(terminal.execute(""), /INVALID_COMMAND/);
  await assert.rejects(terminal.execute("x".repeat(8193)), /INVALID_COMMAND/);
  assert.equal(calls.length, 0);
  await assert.rejects(terminal.execute("true"), /CREATION_UNVERIFIED/);
  assert.equal(calls.length, 1);
});
