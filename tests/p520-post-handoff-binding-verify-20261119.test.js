import test from "node:test";
import assert from "node:assert/strict";
import {
  PIPE,
  TOKEN,
  RELEASE,
  DEVICE_ID,
  SUPERVISOR_JSON,
} from "../scripts/windows/P520-EXACT-AGENT-BINDING-PREFLIGHT-20261119.mjs";
import {
  inspectPostBinding,
  validatePostBinding,
} from "../scripts/windows/P520-POST-HANDOFF-BINDING-VERIFY-20261119.mjs";

const agentPath =
  "C:\\Users\\Owner\\AppData\\Local\\KMJ-CodeBridge\\private\\agent.json";
const supervisor = () => ({
  pipeName: "kmj-codebridge-supervisor-p520",
  tokenFile: TOKEN,
  agent: { installDir: RELEASE, configPath: agentPath },
  projects: [],
  readOnlyProjects: [],
});
const baseline = () => ({
  id: DEVICE_ID,
  gateway: "https://kmjtechno.com/",
  projects: [
    { id: "kmj-codebridge", root: "C:\\Users\\Owner\\KMJ\\kmj-codebridge" },
  ],
  stateDir: "C:\\Users\\Owner\\AppData\\Local\\KMJ-CodeBridge\\state",
});
const proposed = () => ({
  ...baseline(),
  supervisorPipe: PIPE,
  supervisorTokenFile: TOKEN,
});

test("post-handoff exactly matches the owner-proposed two-field binding", () => {
  assert.deepEqual(validatePostBinding(supervisor(), proposed(), proposed()), {
    verified: true,
    mode: "BOUND",
  });
});

test("post-handoff rejects unbound, wrong pipe, wrong token, added socket", () => {
  for (const change of [
    (x) => {
      delete x.supervisorPipe;
    },
    (x) => {
      x.supervisorPipe = "\\\\.\\pipe\\attacker";
    },
    (x) => {
      x.supervisorTokenFile = "C:\\Other\\token";
    },
    (x) => {
      x.supervisorSocket = "/tmp/other";
    },
  ]) {
    const x = proposed();
    change(x);
    assert.throws(
      () => validatePostBinding(supervisor(), x, proposed()),
      /POST_BINDING_PIPE_IDENTITY/,
    );
  }
});

test("post-handoff rejects unauthorized different projects or extra config", () => {
  for (const change of [
    (x) => {
      x.projects.push({ id: "kmj-main-platform", root: "C:\\Other" });
    },
    (x) => {
      x.gateway = "https://attacker.example";
    },
    (x) => {
      x.arbitraryGrant = true;
    },
  ]) {
    const x = proposed();
    change(x);
    assert.throws(
      () => validatePostBinding(supervisor(), x, proposed()),
      /POST_BINDING_NOT_EXACT_OWNER_PROPOSAL/,
    );
  }
});

test("post-handoff rejects proposed grant and Supervisor identity escalation", () => {
  const x = proposed();
  x.projects.push({ id: "kmj-main-platform", root: "C:\\Other" });
  assert.throws(
    () => validatePostBinding(supervisor(), x, x),
    /BINDING_EXISTING_AGENT_IDENTITY_CHANGED/,
  );
  const s = supervisor();
  s.agent.restartTask = "arbitrary";
  assert.throws(
    () => validatePostBinding(s, proposed(), proposed()),
    /BINDING_SUPERVISOR_SCOPE_CHANGED/,
  );
});

test("post-handoff blocks wrong Windows host before reading a private file", async () => {
  let reads = 0;
  for (const opts of [{ platform: "linux" }, { hostname: "WRONG-PC" }]) {
    await assert.rejects(
      inspectPostBinding({
        platform: "win32",
        hostname: "DESKTOP-5FVJMET",
        ...opts,
        read: () => {
          reads++;
          return supervisor();
        },
        hmac: async () => ({ verified: true, limitedCapabilities: true }),
      }),
      /POST_BINDING_WRONG_DEVICE/,
    );
  }
  assert.equal(reads, 0);
});

test("post-handoff requires an independent authenticated HMAC proof", async () => {
  const samples = new Map([
    [SUPERVISOR_JSON, supervisor()],
    [agentPath, proposed()],
    [agentPath + ".proposed", proposed()],
  ]);
  const base = {
    platform: "win32",
    hostname: "DESKTOP-5FVJMET",
    read: (p) => samples.get(p),
  };
  await assert.rejects(
    inspectPostBinding({
      ...base,
      hmac: async () => ({ verified: false, limitedCapabilities: true }),
    }),
    /POST_BINDING_HMAC_NOT_VERIFIED/,
  );
  const output = await inspectPostBinding({
    ...base,
    hmac: async () => ({ verified: true, limitedCapabilities: true }),
  });
  assert.deepEqual(output, { verified: true, mode: "BOUND" });
});
