import test from "node:test";
import assert from "node:assert/strict";
import { connectionHealth } from "../src/gateway.js";

test("connection health classifies online stale offline and never-seen states", () => {
  const base = Date.parse("2026-10-05T15:40:00.000Z");
  const health = {
    sessionCount: 3,
    sessionStartedAt: base - 5000,
    lastHealthAt: base - 5000,
  };

  assert.deepEqual(connectionHealth(base - 10000, health, base), {
    online: true,
    connectionState: "online",
    lastSeenAt: new Date(base - 10000).toISOString(),
    lastSeenAgeMs: 10000,
    gatewaySessionCount: 3,
    sessionStartedAt: new Date(base - 5000).toISOString(),
    lastHealthAt: new Date(base - 5000).toISOString(),
  });

  assert.equal(
    connectionHealth(base - 45000, health, base).connectionState,
    "stale",
  );
  assert.equal(
    connectionHealth(base - 180000, health, base).connectionState,
    "offline",
  );
  assert.deepEqual(connectionHealth(null, null, base), {
    online: false,
    connectionState: "never_seen",
    lastSeenAt: null,
    lastSeenAgeMs: null,
    gatewaySessionCount: 0,
    sessionStartedAt: null,
    lastHealthAt: null,
  });
});

test("connection health clamps future clock skew and invalid session metadata", () => {
  const base = Date.parse("2026-10-05T15:40:00.000Z");
  const result = connectionHealth(
    base + 5000,
    {
      sessionCount: -1,
      sessionStartedAt: Number.NaN,
      lastHealthAt: 0,
    },
    base,
  );
  assert.equal(result.online, true);
  assert.equal(result.connectionState, "online");
  assert.equal(result.lastSeenAgeMs, 0);
  assert.equal(result.gatewaySessionCount, 0);
  assert.equal(result.sessionStartedAt, null);
  assert.equal(result.lastHealthAt, null);
});
