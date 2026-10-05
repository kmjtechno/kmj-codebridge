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
  pro: { INR: 149, USD: 1.99, devices: 3, projects: 10, concurrentJobs: 3 },
  team: {
    INR: 399,
    USD: 4.99,
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
  for (const required of ["₹149", "US$1.99", "₹399", "US$4.99", "30 days"])
    if (!text.includes(required)) fail(label + " missing " + required);
}

const generatedProblems = generatedDrift();
if (generatedProblems.length)
  fail("generated metadata drift: " + generatedProblems.join(", "));

console.log(
  "Canonical CodeBridge product manifest and generated metadata verified.",
);
