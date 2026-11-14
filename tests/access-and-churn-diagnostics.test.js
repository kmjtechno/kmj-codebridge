import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_CHURN_FLAPPING_COUNT,
  SESSION_CHURN_WINDOW_MS,
  SESSION_HISTORY_LIMIT,
  accessDenialReason,
  accessSummary,
  recordSessionStart,
  sessionChurn,
} from "../src/gateway.js";

test("one session per start is stable; repeated new sessions inside the window are flapping", () => {
  const base = 1_800_000_000_000;
  let health = recordSessionStart(undefined, base);
  assert.equal(health.sessionCount, 1);
  assert.equal(health.sessionStartedAt, base);
  assert.equal(health.lastHealthAt, base);
  assert.deepEqual(sessionChurn(health, base + 1000), {
    recentSessionCount: 1,
    recentSessionWindowSeconds: SESSION_CHURN_WINDOW_MS / 1000,
    sessionChurn: "stable",
  });

  for (let i = 1; i < SESSION_CHURN_FLAPPING_COUNT; i += 1)
    health = recordSessionStart(health, base + i * 30000);
  const flapping = sessionChurn(health, base + 150000);
  assert.equal(flapping.recentSessionCount, SESSION_CHURN_FLAPPING_COUNT);
  assert.equal(flapping.sessionChurn, "flapping");

  // Old sessions age out of the window; the lifetime count is unaffected.
  const later = sessionChurn(health, base + SESSION_CHURN_WINDOW_MS * 2);
  assert.equal(later.recentSessionCount, 0);
  assert.equal(later.sessionChurn, "stable");
  assert.equal(health.sessionCount, SESSION_CHURN_FLAPPING_COUNT);
});

test("session history is bounded and malformed health never throws", () => {
  let health;
  for (let i = 0; i < SESSION_HISTORY_LIMIT * 3; i += 1)
    health = recordSessionStart(health, 1_800_000_000_000 + i);
  assert.equal(health.recentSessionStarts.length, SESSION_HISTORY_LIMIT);
  assert.equal(health.sessionCount, SESSION_HISTORY_LIMIT * 3);
  for (const bad of [null, undefined, {}, { recentSessionStarts: "x" }])
    assert.equal(sessionChurn(bad).sessionChurn, "stable");
  assert.equal(
    sessionChurn({ recentSessionStarts: [Number.NaN, "a", 9e15] }, 1000)
      .recentSessionCount,
    0,
  );
  assert.equal(
    recordSessionStart({ sessionCount: 4, recentSessionStarts: "x" }, 5)
      .sessionCount,
    5,
  );
});

test("a denial names missing OAuth scope separately from a missing account permission", () => {
  const readOnlySignIn = {
    permissions: ["read"],
    grantedScopes: ["codebridge:read", "openid"],
  };
  assert.equal(
    accessDenialReason(readOnlySignIn, "write", true),
    "OAUTH_SCOPE_NOT_GRANTED",
  );
  const scopedButNoAccountRight = {
    permissions: ["read"],
    grantedScopes: ["codebridge:read", "codebridge:write"],
  };
  assert.equal(
    accessDenialReason(scopedButNoAccountRight, "write", true),
    "ACCOUNT_PERMISSION_NOT_GRANTED",
  );
  // Static-token deployments have no scopes at all.
  assert.equal(
    accessDenialReason({ permissions: ["read"] }, "write", false),
    "ACCOUNT_PERMISSION_NOT_GRANTED",
  );
  assert.equal(
    accessDenialReason(undefined, "execute", true),
    "ACCOUNT_PERMISSION_NOT_GRANTED",
  );
});

test("access summary lists only the caller's own scopes and what is missing", () => {
  assert.deepEqual(
    accessSummary(
      {
        permissions: ["read"],
        grantedScopes: ["openid", "codebridge:read"],
      },
      true,
    ),
    {
      effectivePermissions: ["read"],
      grantedScopes: ["codebridge:read"],
      missing: [
        { permission: "write", reason: "OAUTH_SCOPE_NOT_GRANTED" },
        { permission: "execute", reason: "OAUTH_SCOPE_NOT_GRANTED" },
      ],
    },
  );
  assert.deepEqual(
    accessSummary({ permissions: ["execute", "read", "write"] }, false),
    {
      effectivePermissions: ["execute", "read", "write"],
      grantedScopes: null,
      missing: [],
    },
  );
});
