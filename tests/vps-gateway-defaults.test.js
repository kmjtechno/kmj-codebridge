import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { generatedDrift } from "../scripts/generate-product-artifacts.js";
import { assertVpsDeployedCommit } from "../scripts/verify-vps-catalog.mjs";

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
    assert.match(
      source.slice(marker),
      /gateway = 'https:\/\/kmjtechno\.com\/?'/,
    );
  }
});

test("VPS smoke requires a full deployed commit and optional exact release parity", () => {
  const live = "95ac3a54743f11f0d28800e72f7231613525f916";
  const earlier = "9c515a1cf91050dbaa9fe764887feb2aec3a8074";
  assert.equal(assertVpsDeployedCommit(live), live);
  assert.equal(assertVpsDeployedCommit(live, live), live);
  assert.throws(() => assertVpsDeployedCommit(null), /VPS_COMMIT_UNVERIFIED/);
  assert.throws(
    () => assertVpsDeployedCommit("short"),
    /VPS_COMMIT_UNVERIFIED/,
  );
  assert.throws(
    () => assertVpsDeployedCommit(live, earlier),
    (error) => {
      assert.equal(error.message, "VPS_COMMIT_MISMATCH");
      assert.equal(error.expectedCommit, earlier);
      assert.equal(error.observedCommit, live);
      return true;
    },
  );
  assert.throws(
    () => assertVpsDeployedCommit(live, "untrusted-env-value"),
    (error) => {
      assert.equal(error.message, "VPS_COMMIT_MISMATCH");
      assert.equal(Object.hasOwn(error, "expectedCommit"), false);
      assert.equal(Object.hasOwn(error, "observedCommit"), false);
      return true;
    },
  );
  const smokeSource = read("scripts/verify-vps-catalog.mjs");
  assert.match(smokeSource, /KMJ_VPS_MCP_COMMIT_EXPECTED=/);
  assert.match(smokeSource, /KMJ_VPS_MCP_COMMIT_OBSERVED=/);
  assert.match(smokeSource, /FULL_SHA\.test\(error\?\.expectedCommit\)/);
  assert.match(smokeSource, /FULL_SHA\.test\(error\?\.observedCommit\)/);
});
