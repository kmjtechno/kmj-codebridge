import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyPreparedSupervisor } from "../scripts/windows/verify-p720-supervisor.mjs";

function sha(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-p720-hmac-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtime = path.join(root, "e3587be842dcc701236b54a2e1de90238a5c3429");
  const source = path.join(runtime, "src");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, "supervisor-client.js"), "");
  const backup = path.join(root, "backups");
  fs.mkdirSync(backup);
  const token = path.join(root, "supervisor.token");
  fs.writeFileSync(token, "a".repeat(64));
  const cfg = {
    pipeName: "kmj-codebridge-supervisor-p720",
    tokenFile: token,
    agent: { installDir: runtime },
    projects: [],
  };
  const configPath = path.join(backup, "supervisor.json");
  fs.writeFileSync(configPath, JSON.stringify(cfg));
  const manifest = {
    schema: 2,
    taskName: "KMJ-CodeBridge-Supervisor",
    tokenFile: token,
    tokenCreatedByInstaller: true,
    tokenSha256: sha(token),
    files: [
      {
        source: path.join(root, "supervisor.json"),
        backup: configPath,
        sha256: sha(configPath),
      },
    ],
  };
  fs.writeFileSync(
    path.join(backup, "manifest.json"),
    JSON.stringify(manifest),
  );
  return { root, backup, token, manifest };
}

test("verified native supervisor health must be authenticated and scoped", async (t) => {
  const { backup } = fixture(t);
  let actual;
  const result = await verifyPreparedSupervisor(backup, {
    mockClient: async (...args) => {
      actual = args;
      return {
        supervisor: "windows-native",
        service: "agent",
        platform: "win32",
      };
    },
  });
  assert.equal(result.verified, true);
  assert.equal(result.agentWired, false);
  assert.equal(actual[1].op, "status");
  assert.equal(actual[1].service, "agent");
  assert.equal(
    actual[0].pipePath,
    "\\\\.\\pipe\\kmj-codebridge-supervisor-p720",
  );
});

test("a legacy Windows PowerShell UTF-8 BOM manifest remains verifiable", async (t) => {
  const { backup } = fixture(t);
  const file = path.join(backup, "manifest.json");
  const source = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, "\uFEFF" + source, "utf8");
  const verified = await verifyPreparedSupervisor(backup, {
    mockClient: async () => ({
      supervisor: "windows-native",
      service: "agent",
      platform: "win32",
    }),
  });
  assert.equal(verified.verified, true);
  assert.equal(verified.agentWired, false);
});

test("changed token or snapshot is rejected before connecting", async (t) => {
  const { backup, token } = fixture(t);
  fs.writeFileSync(token, "b".repeat(64));
  await assert.rejects(
    verifyPreparedSupervisor(backup, {
      mockClient: async () => assert.fail("must not connect"),
    }),
    /SUPERVISOR_TOKEN_MISMATCH/,
  );
});

test("untrusted runtime identity is rejected before connecting", async (t) => {
  const { backup } = fixture(t);
  const mf = JSON.parse(fs.readFileSync(path.join(backup, "manifest.json")));
  const configEntry = mf.files[0];
  const cfg = JSON.parse(fs.readFileSync(configEntry.backup));
  cfg.agent.installDir = path.join(
    path.dirname(cfg.agent.installDir),
    "unknown-runtime",
  );
  fs.writeFileSync(configEntry.backup, JSON.stringify(cfg));
  mf.files[0].sha256 = sha(configEntry.backup);
  fs.writeFileSync(path.join(backup, "manifest.json"), JSON.stringify(mf));
  await assert.rejects(
    verifyPreparedSupervisor(backup, {
      mockClient: async () => assert.fail("must not connect"),
    }),
    /SUPERVISOR_RUNTIME_NOT_PINNED/,
  );
});

test("a non-Windows or spoofed response cannot claim verified status", async (t) => {
  const { backup } = fixture(t);
  await assert.rejects(
    verifyPreparedSupervisor(backup, {
      mockClient: async () => ({ supervisor: "linux" }),
    }),
    /SUPERVISOR_INVALID_HEALTH/,
  );
});
