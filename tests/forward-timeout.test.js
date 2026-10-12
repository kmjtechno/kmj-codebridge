import test from "node:test";
import assert from "node:assert/strict";
import { forwardTimeoutMs } from "../src/gateway.js";

// Root cause of the Qwen2.5-Coder 7B DEVICE_TIMEOUT: the gateway's round-trip
// wait for every forwarded tool was capped by the single fixed
// config.deviceTimeoutMs (15s default), even for local_model_generate and
// autopilot_local_draft, which separately accept their own timeoutSeconds
// (5-90s) for the device-side Ollama call. A measured real cold 7B load
// alone took ~12.17s, leaving almost no margin before the gateway abandoned
// real in-progress work as DEVICE_TIMEOUT.

test("forwardTimeoutMs leaves the configured default untouched for ordinary tools", () => {
  assert.equal(forwardTimeoutMs(15000, "git_status", {}), 15000);
  assert.equal(forwardTimeoutMs(15000, "write_file", { timeoutSeconds: 90 }), 15000);
});

test("forwardTimeoutMs leaves the default untouched when timeoutSeconds is absent or not finite", () => {
  assert.equal(forwardTimeoutMs(15000, "local_model_generate", {}), 15000);
  assert.equal(
    forwardTimeoutMs(15000, "autopilot_local_draft", { timeoutSeconds: "85" }),
    15000,
  );
  assert.equal(
    forwardTimeoutMs(15000, "local_model_generate", { timeoutSeconds: NaN }),
    15000,
  );
});

test("forwardTimeoutMs extends the wait for local_model_generate/autopilot_local_draft to actually cover their own timeoutSeconds plus margin", () => {
  // 85s request -> 85000 + 15000 = 100000, well above the 15s default.
  assert.equal(
    forwardTimeoutMs(15000, "autopilot_local_draft", { timeoutSeconds: 85 }),
    100000,
  );
  assert.equal(
    forwardTimeoutMs(15000, "local_model_generate", { timeoutSeconds: 85 }),
    100000,
  );
});

test("forwardTimeoutMs never shrinks below the configured deviceTimeoutMs default", () => {
  // A short timeoutSeconds request must never reduce the operator's own
  // configured gateway-wide default.
  assert.equal(
    forwardTimeoutMs(15000, "local_model_generate", { timeoutSeconds: 5 }),
    15000,
  );
  // Even with a higher configured default, a short request keeps that floor.
  assert.equal(
    forwardTimeoutMs(60000, "local_model_generate", { timeoutSeconds: 5 }),
    60000,
  );
});

test("forwardTimeoutMs never exceeds gatewaySchema's own 120000ms ceiling, even at timeoutSeconds's own max of 90", () => {
  assert.equal(
    forwardTimeoutMs(15000, "autopilot_local_draft", { timeoutSeconds: 90 }),
    105000,
  );
  // A pathological/out-of-schema-range timeoutSeconds still clamps to the ceiling.
  assert.equal(
    forwardTimeoutMs(15000, "autopilot_local_draft", { timeoutSeconds: 1000 }),
    120000,
  );
});
