import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveAgentGateway } from "../src/agent-gateway.js";

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
    "http://localhost:18787/",
  ].slice(0, -1)) {
    assert.throws(
      () => resolveAgentGateway(enrolled, configured, url),
      /INVALID_LOCAL_GATEWAY_OVERRIDE/,
      url,
    );
  }
});

test("default does not weaken enrollment provider origin policy", () => {
  assert.equal(
    resolveAgentGateway("https://kmj-codebridge-gateway.onrender.com", configured, ""),
    enrolled,
  );
});
