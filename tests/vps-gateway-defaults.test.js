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
