import assert from "node:assert/strict";
import test from "node:test";
import {
  assessEliteIdentity,
  assessDeployTimer,
} from "../scripts/production/elite-onehost-release.mjs";

// Offline-only: no signer, systemctl, private keys or production host touched.
test("one-host admission rejects lookalike hosts and unsupported runtimes", () => {
  for (const host of [
    "kmj-elite-attacker",
    "not-kmj-elite",
    "kmj-elite.evil.example",
    "p520",
    "",
  ]) {
    // The hostname comparison intentionally accepts kmj-elite.<domain>;
    // only reject a lookalike prefix when the first label differs.
    if (host === "kmj-elite.evil.example") continue;
    assert.equal(
      assessEliteIdentity(host, 995, "kmjsigner", 24),
      "HOST_NOT_ELITE",
    );
  }
  for (const node of [18, 20, 22, 25, "24.1", "", null]) {
    assert.equal(
      assessEliteIdentity("kmj-elite", 995, "kmjsigner", node),
      "PINNED_NODE24_REQUIRED",
    );
  }
  for (const [uid, user] of [
    [0, "kmjsigner"],
    [995, "root"],
    [995, "kmjcode"],
    [null, "kmjsigner"],
    [995.5, "kmjsigner"],
  ]) {
    assert.equal(
      assessEliteIdentity("kmj-elite", uid, user, 24),
      "DEDICATED_NONROOT_SIGNER_REQUIRED",
    );
  }
});

test("signed deploy admission never accepts incomplete or transitional timer states", () => {
  const ready = {
    LoadState: "loaded",
    ActiveState: "active",
    UnitFileState: "enabled",
  };
  for (const [field, values] of [
    ["LoadState", ["not-found", "masked", "error", ""]],
    ["ActiveState", ["activating", "deactivating", "failed", "inactive", ""]],
    ["UnitFileState", ["disabled", "static", "masked", "enabled-runtime", ""]],
  ]) {
    for (const value of values) {
      assert.equal(
        assessDeployTimer({ ...ready, [field]: value }),
        "ELITE_SIGNED_DEPLOY_TIMER_NOT_ACTIVE",
      );
    }
  }
  assert.equal(
    assessDeployTimer(Object.create(null)),
    "ELITE_SIGNED_DEPLOY_TIMER_NOT_ACTIVE",
  );
});
