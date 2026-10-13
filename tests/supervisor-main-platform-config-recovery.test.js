import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createSupervisorHandler } from "../src/supervisor.js";

const MAIN_CONFIG = "/etc/kmj-codebridge-main-platform/agent.json";
const DEFAULT_CONFIG = "/etc/kmj-codebridge/agent.json";
const SOCKET = "/run/kmj-codebridge/supervisor.sock";
const PROJECT_ROOT = "/srv/kmj-codebridge-projects/kmj-main-platform";

function config(project = "kmj-main-platform") {
  return JSON.stringify({
    gateway: "https://kmjtechno.com",
    token: "x".repeat(48),
    id: "kmj-elite-main-platform",
    tenant: "t1",
    stateDir: "/var/lib/kmj-codebridge",
    supervisorSocket: SOCKET,
    projects: [{ id: project, root: PROJECT_ROOT, writable: true }],
    license: { mode: "free" },
  });
}

test("main platform project status loads only fixed dedicated config", async () => {
  const observed = [];
  const handler = createSupervisorHandler({
    readFile: (name) => {
      observed.push(name);
      assert.equal(name, MAIN_CONFIG);
      return config();
    },
    exists: (name) => name === PROJECT_ROOT || name === PROJECT_ROOT + "/.git",
    stat: () => ({ isDirectory: () => true }),
  });
  const result = await handler({
    op: "project_status",
    projectId: "kmj-main-platform",
  });
  assert.deepEqual(result.response, {
    projectId: "kmj-main-platform",
    present: true,
    directory: true,
    gitCheckout: true,
  });
  assert.deepEqual(observed, [MAIN_CONFIG]);
  assert.doesNotMatch(JSON.stringify(result), /x{32}/);
});

test("all other projects retain standard fixed agent config", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    readFile: (name) => {
      seen.push(name);
      return config("project_1");
    },
    exists: () => false,
  });
  const result = await handler({ op: "project_status", projectId: "project_1" });
  assert.equal(result.response.present, false);
  assert.deepEqual(seen, [DEFAULT_CONFIG]);
  await assert.rejects(
    handler({ op: "project_status", projectId: "../../etc/shadow" }),
    /INVALID_SUPERVISOR_REQUEST/,
  );
  assert.deepEqual(seen, [DEFAULT_CONFIG]);
});

test("main platform project cannot be forged in unrelated enrollment", async () => {
  const handler = createSupervisorHandler({
    readFile: () => config("other-project"),
    exists: () => {
      throw new Error("no filesystem access expected");
    },
  });
  await assert.rejects(
    handler({ op: "project_status", projectId: "kmj-main-platform" }),
    /SUPERVISOR_PROJECT_NOT_AUTHORIZED/,
  );
});

test("agent config doctor falls back only for missing default config", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    readFile: (name) => {
      seen.push(name);
      if (name === DEFAULT_CONFIG) {
        const error = new Error("no default");
        error.code = "ENOENT";
        throw error;
      }
      assert.equal(name, MAIN_CONFIG);
      return config();
    },
  });
  assert.deepEqual(
    (await handler({ op: "config_validate", service: "agent" })).response,
    { service: "agent", valid: true },
  );
  assert.deepEqual(seen, [DEFAULT_CONFIG, MAIN_CONFIG]);
});

test("malformed default config does not fall back or expose secret", async () => {
  const seen = [];
  const handler = createSupervisorHandler({
    readFile: (name) => {
      seen.push(name);
      if (name === DEFAULT_CONFIG) return "{token=never-print}";
      throw new Error("unexpected fallback");
    },
  });
  const result = await handler({ op: "config_validate", service: "agent" });
  assert.deepEqual(result.response, { service: "agent", valid: false });
  assert.deepEqual(seen, [DEFAULT_CONFIG]);
  assert.doesNotMatch(JSON.stringify(result), /token=never-print/);
});

test("legacy supervisor Python heredoc guards execute real validation", {
  skip: process.platform === "win32",
}, (t) => {
  const bootstrap = fs.readFileSync(
    "scripts/production/bootstrap-existing-supervisor.sh",
    "utf8",
  );
  const bashSyntax = spawnSync(
    "bash",
    ["-n", "scripts/production/bootstrap-existing-supervisor.sh"],
    { encoding: "utf8" },
  );
  assert.equal(bashSyntax.status, 0, bashSyntax.stderr);
  const match = bootstrap.match(
    /python3 - "\$AGENT_CONFIG" "\$SOCKET" <<'PY' \|\| fail "SUPERVISOR_BOOTSTRAP_AGENT_SOCKET_MISMATCH"\n([\s\S]*?)\nPY/,
  );
  assert.ok(match, "fail guard must NOT become Python stdin");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-sup-config-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const filepath = path.join(tmp, "agent.json");
  const runValidation = (data) => {
    fs.writeFileSync(filepath, data, { mode: 0o600 });
    return spawnSync("python3", ["-", filepath, SOCKET], {
      input: match[1] + "\n",
      encoding: "utf8",
    });
  };
  const valid = runValidation(config());
  assert.equal(valid.status, 0, valid.stderr);
  const bad = JSON.parse(config());
  bad.supervisorSocket = "/tmp/unsafe.sock";
  assert.notEqual(runValidation(JSON.stringify(bad)).status, 0);
  bad.supervisorSocket = SOCKET;
  bad.projects = [];
  assert.notEqual(runValidation(JSON.stringify(bad)).status, 0);
});
