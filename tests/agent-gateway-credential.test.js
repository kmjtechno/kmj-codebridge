import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentSchema, enrolledAgentSchema } from "../src/config.js";
import { resolveAgentGatewayCredential } from "../src/agent-gateway-credential.js";

const TOKEN = "fixture-" + "k".repeat(48);

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-agent-token-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, "project");
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(project);
  fs.mkdirSync(stateDir);
  const file = path.join(dir, "bearer.txt");
  const base = {
    gateway: "https://kmjtechno.com/",
    id: "kmj-credential-test",
    tenant: "kmj-test",
    stateDir,
    projects: [{ id: "kmj-test-project", root: project }],
    license: { mode: "free" },
  };
  return { dir, project, stateDir, file, base };
}

test("public agentSchema retains shape for Windows Supervisor schema consumers", () => {
  assert.ok(agentSchema.shape.supervisorPipe);
  assert.ok(agentSchema.shape.supervisorTokenFile);
});

test("gateway credential schema preserves existing inline enrollment", async (t) => {
  const { base } = setup(t);
  const parsed = enrolledAgentSchema.parse({ ...base, token: TOKEN });
  assert.equal(await resolveAgentGatewayCredential(parsed), TOKEN);
  assert.equal(parsed.gatewayTokenFile, undefined);
});

test("gateway credential schema rejects both or neither credential sources", (t) => {
  const { base, file } = setup(t);
  for (const input of [
    base,
    { ...base, token: TOKEN, gatewayTokenFile: file },
    { ...base, token: "too-short" },
  ]) {
    assert.throws(() => enrolledAgentSchema.parse(input));
  }
});

test("gateway credential file stays outside project/state and removes only a final line ending", async (t) => {
  const { file, base } = setup(t);
  fs.writeFileSync(file, TOKEN + "\r\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  const config = enrolledAgentSchema.parse({ ...base, gatewayTokenFile: file });
  if (process.platform === "win32") {
    assert.equal(
      await resolveAgentGatewayCredential(config, {
        validateWindowsAcl: async () => ({ ok: true }),
      }),
      TOKEN,
    );
  } else {
    assert.equal(await resolveAgentGatewayCredential(config), TOKEN);
  }
  assert.equal(fs.readFileSync(file, "utf8"), TOKEN + "\r\n");
  assert.equal(config.token, undefined);
});

test("unsafe gateway credential files fail closed without exposing secret or filename", async (t) => {
  const { file, base, project, stateDir, dir } = setup(t);
  const original = TOKEN + "\n";
  const invalid = async (filename) => {
    await assert.rejects(
      () =>
        resolveAgentGatewayCredential({
          ...base,
          gatewayTokenFile: filename,
        }),
      (error) =>
        error.message === "AGENT_GATEWAY_CREDENTIAL_FILE_UNSAFE" &&
        !error.message.includes(TOKEN) &&
        !error.message.includes(dir),
    );
  };
  fs.writeFileSync(file, original, { mode: 0o600 });
  fs.chmodSync(file, 0o600);

  await assert.rejects(
    () =>
      resolveAgentGatewayCredential({
        ...base,
        gatewayTokenFile: "relative.txt",
      }),
    /AGENT_GATEWAY_CREDENTIAL_PATH_NOT_ABSOLUTE/,
  );
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o644);
    await invalid(file);
    fs.chmodSync(file, 0o600);
    const symlink = path.join(dir, "symlink.txt");
    fs.symlinkSync(file, symlink);
    await invalid(symlink);
  }

  const inProject = path.join(project, "token");
  fs.writeFileSync(inProject, TOKEN, { mode: 0o600 });
  await invalid(inProject);
  const inState = path.join(stateDir, "token");
  fs.writeFileSync(inState, TOKEN, { mode: 0o600 });
  await invalid(inState);
  fs.writeFileSync(file, "too-short", { mode: 0o600 });
  await invalid(file);
  fs.writeFileSync(file, TOKEN + "\nMORE", { mode: 0o600 });
  await invalid(file);
  assert.equal(fs.readFileSync(file, "utf8"), TOKEN + "\nMORE");
});

test("Windows external bearer path requires successful ACL inspection before read", async (t) => {
  const { file, base } = setup(t);
  fs.writeFileSync(file, TOKEN, { mode: 0o600 });
  const config = { ...base, gatewayTokenFile: file };
  let checked = 0;
  await assert.rejects(
    () =>
      resolveAgentGatewayCredential(config, {
        platform: "win32",
        validateWindowsAcl: async () => {
          checked++;
          return { ok: false, reason: "TOKEN_ACL_TOO_BROAD" };
        },
      }),
    /AGENT_GATEWAY_CREDENTIAL_FILE_UNSAFE/,
  );
  assert.equal(checked, 1);
  assert.equal(
    await resolveAgentGatewayCredential(config, {
      platform: "win32",
      validateWindowsAcl: async () => ({ ok: true }),
    }),
    TOKEN,
  );
});
