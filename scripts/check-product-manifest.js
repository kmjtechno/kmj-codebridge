import fs from "node:fs";
import { generatedDrift } from "./generate-product-artifacts.js";

function fail(message) {
  throw new Error("PRODUCT_MANIFEST_INVALID: " + message);
}

function httpsUrl(value, { path = null } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("invalid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail("non-canonical HTTPS URL");
  if (path !== null && url.pathname !== path) fail("unexpected URL path");
  return url;
}

const manifest = JSON.parse(
  fs.readFileSync("product/codebridge-product.json", "utf8"),
);
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

if (manifest.schema !== 2) fail("unsupported schema");
if (manifest.product?.name !== "KMJ CodeBridge") fail("product name mismatch");
if (manifest.product?.slug !== "kmj-codebridge") fail("product slug mismatch");
if (manifest.product?.package !== pkg.name) fail("package name mismatch");
if (manifest.product?.developer !== "KMJ TECHNO") fail("developer mismatch");
if (manifest.product?.category !== "Developer Tools") fail("category mismatch");
if (manifest.versions?.stable !== pkg.version) fail("stable version mismatch");
if (manifest.versions?.minimumAgent !== pkg.version)
  fail("minimum agent version mismatch");
if (manifest.versions?.minimumClientPackage !== pkg.version)
  fail("minimum client package version mismatch");

httpsUrl(manifest.product.website, { path: "/" });
httpsUrl(manifest.product.repository);
httpsUrl(manifest.product.homepage);
httpsUrl(manifest.product.privacy);
httpsUrl(manifest.product.terms);
httpsUrl(manifest.product.support);
httpsUrl(manifest.endpoints?.mcp, { path: "/mcp" });
httpsUrl(manifest.endpoints?.enrollment, { path: "/" });
httpsUrl(manifest.endpoints?.agentGateway, { path: "/" });

if (
  !Number.isInteger(manifest.launch?.trialDays) ||
  manifest.launch.trialDays < 1 ||
  manifest.launch.trialDays > 60 ||
  manifest.launch.trialCardRequired !== false ||
  manifest.launch.trialAutoConvert !== false
)
  fail("invalid launch trial contract");

if (!Array.isArray(manifest.plans) || manifest.plans.length < 4)
  fail("missing plans");
const ids = manifest.plans.map((plan) => plan.id);
if (new Set(ids).size !== ids.length) fail("duplicate plan ids");

const expected = {
  community: { INR: 0, USD: 0, devices: 1, projects: 1, concurrentJobs: 1 },
  pro: { INR: 299, USD: 7, devices: 3, projects: 10, concurrentJobs: 3 },
  team: {
    INR: 699,
    USD: 10,
    devicesPerUser: 10,
    projectsPerUser: 50,
    concurrentJobsPerUser: 10,
  },
};
for (const [id, contract] of Object.entries(expected)) {
  const plan = manifest.plans.find((candidate) => candidate.id === id);
  if (!plan) fail("missing plan " + id);
  if (plan.prices?.INR !== contract.INR || plan.prices?.USD !== contract.USD)
    fail("price drift for " + id);
  for (const [key, value] of Object.entries(contract)) {
    if (key === "INR" || key === "USD") continue;
    if (plan.limits?.[key] !== value) fail("limit drift for " + id + "." + key);
  }
}
if (
  !manifest.plans.some(
    (plan) => plan.id === "business" && plan.customPricing === true,
  )
)
  fail("business custom pricing missing");

// This public metadata is an OWNER REVIEW PROPOSAL, not a running gateway
// meter, payment entitlement, active quota or production activation.
const usage = manifest.launch?.hostedUsageProposal;
if (
  usage?.status !== "proposal_only" ||
  usage.authority !== "KMJ Main Platform (hosted)" ||
  usage.unit !== "completed remote device tool calls" ||
  usage.period !== "calendar_month_utc" ||
  usage.resetDayUtc !== 1 ||
  usage.alertPercent !== 80 ||
  usage.hardStopWhenExhausted !== true ||
  usage.noOverageOrAutoCharge !== true ||
  usage.providerAiFeesIncluded !== false ||
  usage.selfHostedApache2Metered !== false
) fail("monthly hosted usage proposal contract drift");
const monthlyProposals = {
  community: { calls: 10000, perUser: false, custom: false },
  pro: { calls: 100000, perUser: false, custom: false },
  team: { calls: 300000, perUser: true, custom: false },
  business: { calls: null, perUser: false, custom: true },
};
for (const [id, expectedProposal] of Object.entries(monthlyProposals)) {
  const plan = manifest.plans.find((candidate) => candidate.id === id);
  const proposal = plan?.hostedUsageProposal;
  if (
    !proposal ||
    proposal.monthlyToolCalls !== expectedProposal.calls ||
    proposal.perUser !== expectedProposal.perUser ||
    proposal.customContract !== expectedProposal.custom
  ) fail("monthly proposed quota drift for " + id);
}

if (manifest.product?.assets?.logo !== "plugin/assets/icon.png")
  fail("canonical logo asset mismatch");
if (manifest.product?.assets?.icon !== "plugin/assets/icon.png")
  fail("canonical icon asset mismatch");
if (
  manifest.marketplaces?.openai?.appId !==
  "asdk_app_6ac22c9a4cc881918c59cdd9acda428f"
)
  fail("OpenAI app id mismatch");
if (manifest.marketplaces?.openai?.mcpEndpoint !== manifest.endpoints?.mcp)
  fail("OpenAI MCP endpoint mismatch");

if (
  !manifest.product?.assets?.logo ||
  !manifest.product?.assets?.icon ||
  !fs.existsSync(manifest.product.assets.logo) ||
  !fs.existsSync(manifest.product.assets.icon)
)
  fail("missing product assets");

if (
  !Array.isArray(manifest.supportedClients) ||
  manifest.supportedClients.length < 5 ||
  new Set(manifest.supportedClients).size !== manifest.supportedClients.length
)
  fail("invalid supported client list");

if (
  !manifest.features ||
  !manifest.marketplaces ||
  !manifest.updateChannels?.includes("stable")
)
  fail("missing release metadata");

const serialized = JSON.stringify(manifest).toLowerCase();
for (const forbidden of [
  "private_key",
  "client_secret",
  "access_token",
  "refresh_token",
  "bearer ",
])
  if (serialized.includes(forbidden))
    fail("secret-shaped field in public manifest");

const pricing = fs.readFileSync("docs/PRICING.md", "utf8");
const readme = fs.readFileSync("README.md", "utf8");
for (const [label, text] of [
  ["docs/PRICING.md", pricing],
  ["README.md", readme],
]) {
  for (const required of ["₹299", "US$7", "₹699", "US$10", "14 days"])
    if (!text.includes(required)) fail(label + " missing " + required);
}

const generatedProblems = generatedDrift();
if (generatedProblems.length)
  fail("generated metadata drift: " + generatedProblems.join(", "));

console.log(
  "Canonical CodeBridge product manifest and generated metadata verified.",
);
