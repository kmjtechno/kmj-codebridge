import test from "node:test";
import assert from "node:assert/strict";
import { auditBrandAssets } from "../scripts/audit-brand-assets.js";

test("canonical CodeBridge brand icon and all product metadata agree", () => {
  const result = auditBrandAssets();
  assert.equal(result.sourceStatus, "PASS");
  assert.equal(result.packagesIdentical, true);
  assert.equal(result.metadataConsistent, true);
  assert.ok(result.icon.width >= 64);
  assert.equal(result.icon.width, result.icon.height);
  assert.match(result.icon.sha256, /^[a-f0-9]{64}$/);
});
test("source icon matching does not falsely claim published ChatGPT logo corrected", () => {
  const result = auditBrandAssets();
  assert.equal(result.liveMarketplaceListingStatus, "NOT_VERIFIED");
  assert.equal(result.liveBrandingReady, false);
  assert.match(result.nextAction, /authorized app ID/);
});
