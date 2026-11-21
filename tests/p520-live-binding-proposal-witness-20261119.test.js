// P520-only real operator witness. Before handoff, validate exact additive
// proposal. After handoff, require final exact config + authenticated HMAC.
// Never accept a pre-handoff failure as evidence of a successful handoff.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { inspectLocalBinding } from "../scripts/windows/P520-EXACT-AGENT-BINDING-PREFLIGHT-20261119.mjs";
import { inspectPostBinding } from "../scripts/windows/P520-POST-HANDOFF-BINDING-VERIFY-20261119.mjs";

const onP520 =
  process.platform === "win32" &&
  os.hostname().toUpperCase() === "DESKTOP-5FVJMET";

test(
  "P520 physical agent binding matches exact pre- or post-handoff state",
  { skip: !onP520 },
  async () => {
    try {
      assert.equal(inspectLocalBinding().verified, true);
      console.log("P520_REAL_AGENT_BINDING=PASS_UNBOUND_EXACT_PROPOSAL");
    } catch (error) {
      if (String(error?.message) !== "BINDING_EXISTING_AGENT_IDENTITY_CHANGED")
        throw error;
      const result = await inspectPostBinding();
      assert.deepEqual(result, { verified: true, mode: "BOUND" });
      console.log("P520_REAL_AGENT_BINDING=PASS_BOUND_HMAC_AUTHENTICATED");
    }
  },
);
