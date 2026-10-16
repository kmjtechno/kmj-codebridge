import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createToolGuardHost,
  registerReadOnlyProjectGuard,
} from "../src/tool-guard-host.js";
import { createDispatcher } from "../src/tools.js";

function makeDispatch(t, host, writable = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-tool-guard-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  const dispatch = createDispatcher(
    {
      id: "d1",
      stateDir: dir,
      projects: [{ id: "p1", root, writable, gates: {}, commands: {} }],
    },
    { maxConcurrent: 1 },
    () => ({
      features: ["read", "write", "execute"],
      limits: { concurrent_jobs: 1 },
    }),
    null,
    null,
    null,
    undefined,
    null,
    host,
  );
  return { dispatch, root };
}

test("extensions are reversible, ordered, and scoped to one project", async () => {
  const host = createToolGuardHost();
  const seen = [];
  const removeGlobal = host.register({
    id: "recorder",
    beforeExecute: (facts) => {
      assert.equal(Object.isFrozen(facts), true);
      seen.push(facts);
      return "allow";
    },
  });
  const removeSpecific = host.register({
    id: "block-write",
    project: "p1",
    beforeExecute: ({ access }) => (access === "write" ? "deny" : "allow"),
  });
  const request = {
    device: "d1",
    project: "p1",
    tool: "write_file",
    access: "write",
    writable: true,
  };
  await assert.rejects(host.preflight(request), /TOOL_GUARD_DENIED/);
  assert.deepEqual(Object.keys(seen[0]), [
    "device",
    "project",
    "tool",
    "access",
    "writable",
  ]);
  await host.preflight({ ...request, project: "p2" });
  removeSpecific();
  removeSpecific();
  await host.preflight(request);
  removeGlobal();
  assert.deepEqual(host.status(), {
    installed: 0,
    dynamicPluginLoading: false,
    canGrantPermissions: false,
  });
  assert.equal(seen.length, 3);
});

test("built-in guard denies write to read-only projects but retains read access", async (t) => {
  const host = createToolGuardHost();
  registerReadOnlyProjectGuard(host);
  const { dispatch, root } = makeDispatch(t, host, false);
  const inspection = await dispatch(
    "inspect_project",
    { device: "d1", project: "p1" },
    ["read"],
  );
  assert.equal(inspection.writable, false);
  await assert.rejects(
    dispatch(
      "write_file",
      {
        device: "d1",
        project: "p1",
        path: "file.txt",
        content: "content",
        expectedHash: null,
      },
      ["write"],
    ),
    /TOOL_GUARD_DENIED/,
  );
  assert.equal(fs.existsSync(path.join(root, "file.txt")), false);
});

test("trusted policy cannot elevate a user's missing MCP permission", async (t) => {
  const host = createToolGuardHost();
  let invoked = 0;
  host.register({
    id: "allow-all",
    beforeExecute: () => {
      invoked++;
      return "allow";
    },
  });
  const { dispatch } = makeDispatch(t, host);
  await assert.rejects(
    dispatch(
      "write_file",
      {
        device: "d1",
        project: "p1",
        path: "file.txt",
        content: "content",
        expectedHash: null,
      },
      ["read"],
    ),
    /ACCESS_DENIED/,
  );
  assert.equal(invoked, 0);
});

test("invalid, throwing, and malformed plugins fail closed", async () => {
  const data = {
    device: "d1",
    project: "p1",
    tool: "write_file",
    access: "write",
    writable: true,
  };
  const host = createToolGuardHost();
  assert.throws(
    () =>
      host.register({
        id: "../bad",
        beforeExecute: () => "allow",
      }),
    /TOOL_GUARD_REGISTRATION_INVALID/,
  );
  const uninstall = host.register({
    id: "bad-verdict",
    beforeExecute: () => "grant",
  });
  await assert.rejects(host.preflight(data), /TOOL_GUARD_INVALID_VERDICT/);
  uninstall();
  host.register({
    id: "thrower",
    beforeExecute: () => {
      throw new Error("a secret that must not escape");
    },
  });
  await assert.rejects(host.preflight(data), (error) => {
    assert.equal(error.code, "TOOL_GUARD_FAILED");
    assert.equal(error.message.includes("secret"), false);
    return true;
  });
});
