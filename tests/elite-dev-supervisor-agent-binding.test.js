import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import {
  assertSupervisorProjectSocketScope,
  resolveEliteDevSupervisorSocket,
} from "../src/agent.js";
import { ELITE_DEV_SUPERVISOR_SOCKET } from "../src/supervisor-client.js";

const PARENT = "/run/kmj-codebridge-dev";
const UID = 1901;
const GID = 1901;
const agent = () => ({
  id: "kmj-codebridge-elite",
  projects: [{ id: "kmj-codebridge" }],
});
const dir = (override = {}) => ({
  isDirectory: () => true,
  uid: 0,
  mode: 0o40711,
  ...override,
});
const socket = (override = {}) => ({
  isSocket: () => true,
  uid: UID,
  gid: GID,
  nlink: 1,
  mode: 0o140600,
  ...override,
});
function options({ env, parent = dir(), sock = socket(), stat } = {}) {
  return {
    env: env ?? { KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND: "1" },
    platform: "linux",
    uid: UID,
    gid: GID,
    stat:
      stat ??
      ((path) => {
        if (path === PARENT) return parent;
        if (path === ELITE_DEV_SUPERVISOR_SOCKET) return sock;
        throw new Error("UNEXPECTED_PATH");
      }),
  };
}

test("only exact enrolled kmjdev project can opt in without editing credentials", () => {
  const original = agent();
  const before = structuredClone(original);
  const got = resolveEliteDevSupervisorSocket(original, options());
  assert.equal(got, ELITE_DEV_SUPERVISOR_SOCKET);
  assert.deepEqual(original, before, "binding is pure; no config rewrite");
  assert.doesNotThrow(() =>
    assertSupervisorProjectSocketScope({
      ...original,
      supervisorSocket: got,
    }),
  );
  assert.equal(
    resolveEliteDevSupervisorSocket(original, options({ env: {} })),
    undefined,
  );
});

test("no environment flag leaves existing explicit Linux supervisor binding unchanged", () => {
  assert.equal(
    resolveEliteDevSupervisorSocket(
      { ...agent(), supervisorSocket: ELITE_DEV_SUPERVISOR_SOCKET },
      options({ env: {} }),
    ),
    ELITE_DEV_SUPERVISOR_SOCKET,
  );
});

test("hostile or irrelevant root unit flags never bind other devices or scopes", () => {
  const bad = [
    { ...agent(), id: "kmj-elite-main-platform" },
    { ...agent(), id: "kmj-elite-cloudos" },
    { ...agent(), projects: [{ id: "kmj-cloudos" }] },
    { ...agent(), projects: [] },
    {
      ...agent(),
      projects: [{ id: "kmj-codebridge" }, { id: "kmj-main-platform" }],
    },
    { ...agent(), supervisorSocket: "/run/kmj-codebridge/supervisor.sock" },
    {
      ...agent(),
      supervisorSocket: "/run/kmj-codebridge-cloudos/supervisor.sock",
    },
    {
      ...agent(),
      supervisorPipe: "\\\\.\\pipe\\kmj-codebridge-supervisor-p520",
    },
    { ...agent(), supervisorTokenFile: "/tmp/pin" },
  ];
  for (const config of bad)
    assert.throws(
      () => resolveEliteDevSupervisorSocket(config, options()),
      /ELITE_DEV_SUPERVISOR_BINDING_DENIED/,
    );
  for (const flag of ["", "true", "0", "2", "../supervisor.sock"]) {
    assert.throws(
      () =>
        resolveEliteDevSupervisorSocket(
          agent(),
          options({ env: { KMJ_CODEBRIDGE_ELITE_DEV_SUPERVISOR_BIND: flag } }),
        ),
      /ELITE_DEV_SUPERVISOR_BINDING_DENIED/,
    );
  }
  assert.throws(
    () =>
      resolveEliteDevSupervisorSocket(agent(), {
        ...options(),
        platform: "win32",
      }),
    /ELITE_DEV_SUPERVISOR_BINDING_DENIED/,
  );
  assert.throws(
    () => resolveEliteDevSupervisorSocket(agent(), { ...options(), uid: 0 }),
    /ELITE_DEV_SUPERVISOR_BINDING_DENIED/,
  );
});

test("socket must exist, be owned by agent, and be 0600 under trusted root directory", () => {
  const invalid = [
    options({
      stat: () => {
        throw new Error("ENOENT");
      },
    }),
    options({ parent: dir({ uid: UID }) }),
    options({ parent: dir({ mode: 0o40777 }) }),
    options({ parent: dir({ isDirectory: () => false }) }),
    options({ sock: socket({ uid: 0 }) }),
    options({ sock: socket({ gid: 0 }) }),
    options({ sock: socket({ nlink: 2 }) }),
    options({ sock: socket({ mode: 0o140660 }) }),
    options({ sock: socket({ mode: 0o140666 }) }),
    options({ sock: socket({ isSocket: () => false }) }),
  ];
  for (const bad of invalid)
    assert.throws(
      () => resolveEliteDevSupervisorSocket(agent(), bad),
      /ELITE_DEV_SUPERVISOR_BINDING_UNAVAILABLE/,
    );
});

test("startup validates scoped socket before opening gateway credential or acquiring state lock", () => {
  const source = fs.readFileSync("src/agent.js", "utf8");
  const start = source.indexOf("export async function startAgent(");
  const bind = source.indexOf("resolveEliteDevSupervisorSocket(c);", start);
  const credential = source.indexOf("resolveAgentGatewayCredential(c);", start);
  const lock = source.indexOf("acquireAgentLock(state);", start);
  assert.ok(
    start >= 0 && bind > start && credential > bind && lock > credential,
  );
  assert.doesNotMatch(
    source.slice(start, credential),
    /writeFileSync|renameSync|systemctl|supervisorSocket = "[^"]+"/,
  );
});
