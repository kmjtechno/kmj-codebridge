import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  resolveAgentGateway,
  rebindExistingAgentGateway,
} from "../src/agent-gateway.js";

const enrolled = "https://kmj-codebridge-gateway.onrender.com";
const configured = "https://kmjtechno.com";

test("default keeps independently approved remote enrollment gateway", () => {
  assert.equal(resolveAgentGateway(enrolled, configured), enrolled);
  assert.equal(resolveAgentGateway("", configured), configured);
});

test("explicit colocated loopback override switches to local canonical gateway", () => {
  assert.equal(
    resolveAgentGateway(enrolled, configured, "http://127.0.0.1:18787"),
    "http://127.0.0.1:18787",
  );
  assert.equal(
    resolveAgentGateway(enrolled, configured, "http://localhost:18787/"),
    "http://localhost:18787",
  );
  assert.equal(
    resolveAgentGateway(enrolled, configured, "http://[::1]:18787"),
    "http://[::1]:18787",
  );
});

test("never forward enrolled device bearer to non-loopback or URL with credentials", () => {
  for (const url of [
    "http://0.0.0.0:18787",
    "http://10.0.0.1:18787",
    "http://169.254.169.254:18787",
    "https://localhost:18787",
    "https://evil.example",
    "http://evil.example:18787",
    "http://u:p@localhost:18787",
    "http://localhost:18787/path",
    "http://localhost:18787?token=foo",
    "http://localhost:18787/#fragment",
    "http://localhost:80",
    "http://127.0.0.1",
    "not-a-url",
    "x".repeat(129),
  ]) {
    assert.throws(
      () => resolveAgentGateway(enrolled, configured, url),
      /INVALID_LOCAL_GATEWAY_OVERRIDE/,
      url,
    );
  }
});

test("default does not weaken enrollment provider origin policy", () => {
  assert.equal(
    resolveAgentGateway(
      "https://kmj-codebridge-gateway.onrender.com",
      configured,
      "",
    ),
    enrolled,
  );
});

test("existing enrolled config rebinding preserves device token and secure rollback backup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-local-gateway-"));
  const file = path.join(dir, "agent.json");
  try {
    fs.chmodSync(dir, 0o700);
    const credential = "unit-test-only-" + "a".repeat(48);
    const input = {
      gateway: enrolled,
      id: "kmj-elite-main-platform",
      tenant: "test-tenant",
      token: credential,
      projects: [{ id: "kmj-main-platform" }],
    };
    fs.writeFileSync(file, JSON.stringify(input), { mode: 0o600 });
    assert.equal(
      rebindExistingAgentGateway(file, "http://127.0.0.1:18787"),
      true,
    );
    const changed = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual({ ...changed, gateway: enrolled }, input);
    assert.equal(changed.gateway, "http://127.0.0.1:18787");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const backups = fs
      .readdirSync(dir)
      .filter((entry) => entry.includes("before-local-"));
    assert.equal(backups.length, 1);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dir, backups[0]), "utf8")),
      input,
    );
    assert.equal(fs.statSync(path.join(dir, backups[0])).mode & 0o777, 0o600);
    assert.equal(
      rebindExistingAgentGateway(file, "http://127.0.0.1:18787"),
      false,
    );
    assert.equal(fs.readdirSync(dir).length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("existing config rejects external overrides before touching device credentials", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-local-gateway-"));
  const file = path.join(dir, "agent.json");
  try {
    fs.chmodSync(dir, 0o700);
    const original = JSON.stringify({
      gateway: enrolled,
      token: "sensitive-fixture",
    });
    fs.writeFileSync(file, original, { mode: 0o600 });
    assert.throws(
      () => rebindExistingAgentGateway(file, "https://evil.example"),
      /INVALID_LOCAL_GATEWAY_OVERRIDE/,
    );
    assert.equal(fs.readFileSync(file, "utf8"), original);
    assert.deepEqual(fs.readdirSync(dir), ["agent.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("existing agent config symlinks and permissive modes fail closed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-local-gateway-"));
  const file = path.join(dir, "agent.json");
  const link = path.join(dir, "link.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ gateway: enrolled }), {
      mode: 0o644,
    });
    fs.chmodSync(file, 0o644); // Make this independent of the test runner's umask.
    fs.symlinkSync(file, link);
    assert.throws(
      () => rebindExistingAgentGateway(file, "http://127.0.0.1:18787"),
      /UNSAFE_AGENT_CONFIG/,
    );
    assert.throws(
      () => rebindExistingAgentGateway(link, "http://127.0.0.1:18787"),
      /UNSAFE_AGENT_CONFIG/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
