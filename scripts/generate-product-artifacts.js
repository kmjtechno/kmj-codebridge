import fs from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

function readManifest() {
  return JSON.parse(
    fs.readFileSync(path.join(root, "product/codebridge-product.json"), "utf8"),
  );
}

function json(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

function price(plan) {
  if (plan.customPricing) return "Custom";
  if (plan.id === "community") return "Free";
  const inr = plan.prices?.INR;
  const usd = plan.prices?.USD;
  if (plan.id === "team")
    return `₹${inr}/user/mo India · US$${usd}/user/mo global`;
  return `₹${inr}/mo India · US$${usd}/mo global`;
}

function bestFor(id) {
  return {
    community: "OSS users, evaluation, one device/project",
    pro: "Individual developers",
    team: "Small engineering teams",
    business: "Larger deployments, support, procurement",
  }[id];
}

export function generatedArtifacts() {
  const manifest = readManifest();
  const clients = {
    schema: 1,
    product: manifest.product.name,
    slug: manifest.product.slug,
    stableVersion: manifest.versions.stable,
    minimumAgentVersion: manifest.versions.minimumAgent,
    minimumClientPackageVersion: manifest.versions.minimumClientPackage,
    endpoints: manifest.endpoints,
    legal: {
      privacy: manifest.product.privacy,
      terms: manifest.product.terms,
      support: manifest.product.support,
    },
    assets: manifest.product.assets,
    supportedClients: manifest.supportedClients,
    marketplaces: manifest.marketplaces,
  };

  const plans = {
    schema: 1,
    product: manifest.product.slug,
    stableVersion: manifest.versions.stable,
    launch: manifest.launch,
    plans: manifest.plans,
  };

  const mainPlatformCatalog = {
    schema: 1,
    source: "product/codebridge-product.json",
    product: manifest.product.slug,
    version: manifest.versions.stable,
    runtimeAuthority: "KMJ Main Platform",
    note:
      "Generated import contract only. Server-side entitlement enforcement remains authoritative.",
    launch: manifest.launch,
    plans: manifest.plans,
  };

  const releaseDashboard = {
    schema: 1,
    product: manifest.product.slug,
    stableVersion: manifest.versions.stable,
    previewVersion: manifest.versions.preview,
    updateChannels: manifest.updateChannels,
    features: manifest.features,
    marketplaces: manifest.marketplaces,
  };

  const planRows = manifest.plans.map(
    (plan) =>
      `| **${plan.name}** | ${price(plan)} | ${bestFor(plan.id) ?? ""} |`,
  );
  const planTable = [
    "<!-- GENERATED from product/codebridge-product.json. Do not edit by hand. -->",
    "",
    "| Plan | Launch price | Best for |",
    "| --- | ---: | --- |",
    ...planRows,
    "",
  ].join("\n");

  const launchOffer = [
    "<!-- GENERATED from product/codebridge-product.json. Do not edit by hand. -->",
    "",
    ...manifest.plans.map((plan) => {
      if (plan.id === "community")
        return `- **${plan.name} — Free forever:** no card required, ${plan.limits.devices} device, ${plan.limits.projects} project, ${plan.limits.concurrentJobs} concurrent job.`;
      if (plan.id === "pro")
        return `- **${plan.name} — ₹${plan.prices.INR}/month in India or US$${plan.prices.USD}/month globally:** introductory price for early adopters while the launch offer is active.`;
      if (plan.id === "team")
        return `- **${plan.name} — ₹${plan.prices.INR}/user/month in India or US$${plan.prices.USD}/user/month globally:** introductory team price.`;
      return `- **${plan.name} — custom:** larger deployments, procurement, advanced support and negotiated limits.`;
    }),
    `- **Trial:** new eligible accounts receive **${manifest.launch.trialDays} days of Pro** with no automatic paid conversion unless the customer explicitly chooses a paid subscription.`,
    `- **Founding users:** accounts that activate a paid Pro or Team subscription during the launch window may keep the launch base price for ${manifest.launch.foundingPriceMonths} months, subject to taxes, abuse controls and the published Terms.`,
    "",
  ].join("\n");

  return new Map([
    ["product/clients.generated.json", json(clients)],
    ["product/plans.generated.json", json(plans)],
    ["product/main-platform-catalog.generated.json", json(mainPlatformCatalog)],
    ["product/release-dashboard.generated.json", json(releaseDashboard)],
    ["product/PLAN-TABLE.generated.md", planTable],
    ["product/LAUNCH-OFFER.generated.md", launchOffer],
  ]);
}

export function generatedDrift() {
  const problems = [];
  for (const [relative, content] of generatedArtifacts()) {
    const file = path.join(root, relative);
    if (!fs.existsSync(file)) {
      problems.push("missing " + relative);
      continue;
    }
    if (fs.readFileSync(file, "utf8") !== content)
      problems.push("outdated " + relative);
  }
  return problems;
}

export function writeGeneratedArtifacts() {
  for (const [relative, content] of generatedArtifacts()) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

if (process.argv[1]?.endsWith("generate-product-artifacts.js")) {
  if (process.argv.includes("--check")) {
    const problems = generatedDrift();
    if (problems.length) {
      console.error(problems.join("\n"));
      console.error(
        "Generated product metadata is stale; run npm run generate:product.",
      );
      process.exitCode = 1;
    } else {
      console.log("Generated product metadata matches canonical manifest.");
    }
  } else {
    writeGeneratedArtifacts();
    console.log("Generated product metadata from canonical manifest.");
  }
}
