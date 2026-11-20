import assert from "node:assert/strict";
import test from "node:test";
import {
  assessEliteIdentity,
  assessDeployTimer,
} from "../scripts/production/elite-onehost-release.mjs";

// Pure offline admission fixtures. Never start signer, timer or deployment.
test("dedicated nonroot signer accepts only the pinned Elite host label and Node 24", () => {
  for (const host of ["kmj-elite", "kmj-elite.example.internal", "KMJ-ELITE"]) {
    assert.equal(assessEliteIdentity(host, 995, "kmjsigner", 24), "PASS");
  }
  assert.equal(
    assessEliteIdentity("kmj-elite-other.example.internal", 995, "kmjsigner", 24),
    "HOST_NOT_ELITE",
  );
});

test("signed deployment timer requires all three stable enabled states", () => {
  const ready = {
    LoadState: "loaded",
    ActiveState: "active",
    UnitFileState: "enabled",
  };
  assert.equal(assessDeployTimer(ready), "PASS");
  for (const field of Object.keys(ready)) {
    const incomplete = { ...ready };
    delete incomplete[field];
    assert.equal(
      assessDeployTimer(incomplete),
      "ELITE_SIGNED_DEPLOY_TIMER_NOT_ACTIVE",
    );
  }
  assert.equal(
    assessDeployTimer(null),
    "ELITE_SIGNED_DEPLOY_TIMER_NOT_ACTIVE",
  );
});
