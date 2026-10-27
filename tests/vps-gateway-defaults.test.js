import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generatedDrift } from "../scripts/generate-product-artifacts.js";

const origin = "https://kmjtechno.com";
const read = (name) => fs.readFileSync(name, "utf8");

test("published CodeBridge agent gateway matches the registered VPS MCP host", () => {
  const manifest = JSON.parse(read("product/codebridge-product.json"));
  const generated = JSON.parse(read("product/clients.generated.json"));
  assert.equal(manifest.endpoints.mcp, origin + "/mcp");
  assert.equal(manifest.endpoints.agentGateway, origin);
  assert.equal(generated.endpoints.agentGateway, origin);
  assert.deepEqual(generatedDrift(), []);
});

test("new Linux and Main Platform installations default to the owner VPS", () => {
  for (const script of [
    "scripts/install-vps.sh",
    "scripts/setup-main-platform-agent.sh",
    "scripts/repair-main-platform-online.sh",
  ]) {
    const source = read(script);
    assert.ok(
      source.includes("CODEBRIDGE_GATEWAY:-" + origin),
      script + " must default to canonical VPS",
    );
    assert.ok(
      !source.includes(
        "CODEBRIDGE_GATEWAY:-https://kmj-codebridge-gateway.onrender.com",
      ),
      script + " must not silently default to Render",
    );
  }
});

test("new credentials reject cross-gateway enrollment before storing the token", () => {
  for (const script of [
    "scripts/install-vps.sh",
    "scripts/setup-main-platform-agent.sh",
  ]) {
    const source = read(script);
    assert.match(source, /ENROLLMENT_GATEWAY_MISMATCH/);
    assert.match(
      source,
      /returned\.origin !== canonical\.origin|approved\.origin !== expected\.origin/,
    );
  }
});

test("fresh Windows P720 pairing rejects cross-host enrollment credentials", () => {
  for (const script of [
    "scripts/setup-p720-codebridge.ps1",
    "scripts/setup-p720-ide.ps1",
    "scripts/setup-p720-cinecore.ps1",
    "scripts/enroll-p720-omnidesk.ps1",
  ]) {
    const source = read(script);
    const marker = source.indexOf("ENROLLMENT_GATEWAY_MISMATCH");
    assert.ok(marker > 0, script + " must reject cross-host enrollment");
    const approvalGuard = source.slice(Math.max(0, marker - 360), marker);
    assert.match(approvalGuard, /https:\/\/kmjtechno\.com/);
    assert.doesNotMatch(
      approvalGuard,
      /kmj-codebridge-gateway\.onrender\.com/,
      script + " must not accept fresh Render-bound grants",
    );
    assert.match(source.slice(marker), /gateway = 'https:\/\/kmjtechno\.com\/?'/);
  }
});
