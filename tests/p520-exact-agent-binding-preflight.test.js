import test from "node:test";
import assert from "node:assert/strict";
import {
  PIPE,
  TOKEN,
  RELEASE,
  SUPERVISOR_JSON,
  DEVICE_ID,
  inspectLocalBinding,
  verifyBindingSnapshot,
} from "../scripts/windows/P520-EXACT-AGENT-BINDING-PREFLIGHT-20261119.mjs";

const agentPath =
  "C:\\Users\\KMJ TECHNO\\AppData\\Local\\KMJ-CodeBridge\\private\\agent.json";
const supervisor = () => ({
  pipeName: "kmj-codebridge-supervisor-p520",
  tokenFile: TOKEN,
  agent: { installDir: RELEASE, configPath: agentPath },
  projects: [],
  readOnlyProjects: [],
});
const current = () => ({
  id: DEVICE_ID,
  gateway: "https://kmjtechno.com/",
  projects: [
    {
      id: "kmj-codebridge",
      root: "C:\\Users\\KMJ TECHNO\\KMJ\\kmj-codebridge",
    },
  ],
  stateDir: "C:\\Users\\KMJ TECHNO\\AppData\\Local\\KMJ-CodeBridge\\state",
});
const proposed = () => ({
  ...current(),
  supervisorPipe: PIPE,
  supervisorTokenFile: TOKEN,
});

test("accepts exact additive P520 binding proposal without changing live agent", () => {
  const v = verifyBindingSnapshot(supervisor(), current(), proposed());
  assert.equal(v.verified, true);
  assert.equal(v.agentConfigPath, agentPath);
});

test("refuses missing, changed or privilege-bearing Supervisor config", () => {
  for (const change of [
    (s) => {
      s.pipeName = "kmj-codebridge-supervisor-p720";
    },
    (s) => {
      s.tokenFile = "C:\\Temp\\token";
    },
    (s) => {
      s.agent.installDir = "C:\\untrusted";
    },
    (s) => {
      s.agent.configPath = "agent.json";
    },
    (s) => {
      s.agent.restartTask = "arbitrary";
    },
    (s) => {
      s.projects.push({ id: "admin" });
    },
  ]) {
    const s = supervisor();
    change(s);
    assert.throws(
      () => verifyBindingSnapshot(s, current(), proposed()),
      /BINDING_SUPERVISOR_SCOPE_CHANGED/,
    );
  }
});

test("refuses untrusted current device identity or preexisting Supervisor wiring", () => {
  for (const change of [
    (a) => {
      a.id = "different";
    },
    (a) => {
      a.gateway = "https://attacker.example";
    },
    (a) => {
      a.projects.push({ id: "other" });
    },
    (a) => {
      a.supervisorSocket = "/tmp/not-windows";
    },
  ]) {
    const a = current();
    change(a);
    assert.throws(
      () => verifyBindingSnapshot(supervisor(), a, proposed()),
      /BINDING_EXISTING_AGENT_IDENTITY_CHANGED/,
    );
  }
});

test("rejects extra proposal mutations and substituted Supervisor endpoints", () => {
  for (const change of [
    (p) => {
      p.supervisorPipe = "\\\\.\\pipe\\other";
    },
    (p) => {
      p.supervisorTokenFile = "C:\\other\\token";
    },
    (p) => {
      p.supervisorSocket = "/tmp/unsafe";
    },
  ]) {
    const p = proposed();
    change(p);
    assert.throws(
      () => verifyBindingSnapshot(supervisor(), current(), p),
      /BINDING_PROPOSAL_ENDPOINT_CHANGED/,
    );
  }
  for (const change of [
    (p) => {
      p.projects[0].root = "C:\\Other";
    },
    (p) => {
      p.stateDir = "C:\\Other";
    },
    (p) => {
      p.extraGrant = "root";
    },
  ]) {
    const p = proposed();
    change(p);
    assert.throws(
      () => verifyBindingSnapshot(supervisor(), current(), p),
      /BINDING_PROPOSAL_UNAPPROVED_DIFFERENCE/,
    );
  }
});

test("blocks wrong workstation before file access", () => {
  let reads = 0;
  for (const patch of [{ platform: "linux" }, { hostname: "OTHER" }]) {
    assert.throws(
      () =>
        inspectLocalBinding({
          platform: "win32",
          hostname: "DESKTOP-5FVJMET",
          ...patch,
          read: () => {
            reads++;
            return supervisor();
          },
        }),
      /BINDING_WRONG_DEVICE/,
    );
  }
  assert.equal(reads, 0);
});

test("read-only preflight reads exact fixed config and owner proposal only", () => {
  const paths = [];
  const fixtures = new Map([
    [SUPERVISOR_JSON, supervisor()],
    [agentPath, current()],
    [agentPath + ".proposed", proposed()],
  ]);
  const r = inspectLocalBinding({
    platform: "win32",
    hostname: "DESKTOP-5FVJMET",
    read: (p) => {
      paths.push(p);
      return fixtures.get(p);
    },
  });
  assert.deepEqual(r, { verified: true });
  assert.deepEqual(paths, [
    SUPERVISOR_JSON,
    agentPath,
    agentPath + ".proposed",
  ]);
});

test("missing proposal always fails closed", () => {
  assert.throws(
    () =>
      inspectLocalBinding({
        platform: "win32",
        hostname: "DESKTOP-5FVJMET",
        read: (p) =>
          p === SUPERVISOR_JSON
            ? supervisor()
            : p === agentPath
              ? current()
              : undefined,
      }),
    /BINDING_JSON_INVALID/,
  );
});
