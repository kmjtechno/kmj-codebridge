import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readJson = (relative) =>
  JSON.parse(readFileSync(new URL("../" + relative, import.meta.url), "utf8"));

const manifest = readJson("product/codebridge-product.json");

test("only hosted CodeBridge usage gets the proposed monthly cap", () => {
  const policy = manifest.launch.hostedUsageProposal;
  assert.equal(policy.status, "proposal_only");
  assert.equal(policy.authority, "KMJ Main Platform (hosted)");
  assert.equal(policy.unit, "completed remote device tool calls");
  assert.equal(policy.period, "calendar_month_utc");
  assert.equal(policy.resetDayUtc, 1);
  assert.equal(policy.alertPercent, 80);
  assert.equal(policy.hardStopWhenExhausted, true);
  assert.equal(policy.noOverageOrAutoCharge, true);
  assert.equal(policy.providerAiFeesIncluded, false);
  assert.equal(policy.selfHostedApache2Metered, false);
});

test("10k free, affordable Pro, per-user Team and custom Business preserve approved prices", () => {
  const plans = Object.fromEntries(manifest.plans.map((p) => [p.id, p]));
  assert.deepEqual(
    ["community", "pro", "team", "business"].sort(),
    Object.keys(plans).sort(),
  );
  assert.deepEqual(
    [plans.community.prices.INR, plans.pro.prices.INR, plans.team.prices.INR],
    [0, 299, 699],
  );
  assert.deepEqual(
    [plans.community.prices.USD, plans.pro.prices.USD, plans.team.prices.USD],
    [0, 7, 10],
  );
  for (const [id, calls, perUser] of [
    ["community", 10000, false],
    ["pro", 100000, false],
    ["team", 300000, true],
  ]) {
    assert.equal(plans[id].hostedUsageProposal.monthlyToolCalls, calls);
    assert.equal(plans[id].hostedUsageProposal.perUser, perUser);
    assert.equal(plans[id].hostedUsageProposal.customContract, false);
  }
  assert.deepEqual(plans.business.hostedUsageProposal, {
    monthlyToolCalls: null,
    perUser: false,
    customContract: true,
  });
  assert.equal(plans.business.customPricing, true);
  assert.deepEqual(
    [plans.community.limits.devices, plans.community.limits.projects, plans.community.limits.concurrentJobs],
    [1, 1, 1],
  );
  assert.deepEqual(
    [plans.pro.limits.devices, plans.pro.limits.projects, plans.pro.limits.concurrentJobs],
    [3, 10, 3],
  );
  assert.deepEqual(
    [plans.team.limits.devicesPerUser, plans.team.limits.projectsPerUser, plans.team.limits.concurrentJobsPerUser],
    [10, 50, 10],
  );
});

test("product contracts remain source-only and generated from one canonical manifest", () => {
  for (const relative of [
    "product/plans.generated.json",
    "product/main-platform-catalog.generated.json",
  ]) {
    const generated = readJson(relative);
    assert.deepEqual(generated.launch, manifest.launch);
    assert.deepEqual(generated.plans, manifest.plans);
  }
  assert.equal(manifest.launch.trialDays, 14);
  assert.equal(manifest.launch.trialCardRequired, false);
  assert.equal(manifest.launch.trialAutoConvert, false);
});
