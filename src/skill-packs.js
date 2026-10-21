const PACKS = Object.freeze([
  Object.freeze({
    id: "security-hardening",
    title: "Security hardening",
    signals: Object.freeze([
      "auth",
      "oauth",
      "oidc",
      "token",
      "secret",
      "credential",
      "permission",
      "tenant",
      "acl",
      "security",
      "crypto",
      "signature",
      "csrf",
      "xss",
    ]),
    workflow: Object.freeze([
      "map trust boundaries and authorization checks",
      "add negative tests before broadening access",
      "preserve secret redaction and fail-closed behavior",
      "run security and required quality gates",
    ]),
    evidence: Object.freeze([
      "negative authorization tests",
      "credential/secret scan",
      "exact-head required CI",
    ]),
  }),
  Object.freeze({
    id: "debugging",
    title: "Systematic debugging",
    signals: Object.freeze([
      "bug",
      "error",
      "failure",
      "failing",
      "crash",
      "regression",
      "timeout",
      "broken",
      "exception",
      "incident",
      "flaky",
    ]),
    workflow: Object.freeze([
      "reproduce or bound the failure",
      "reduce to the smallest useful failing evidence",
      "identify root cause before editing",
      "add a regression test and verify the fix",
    ]),
    evidence: Object.freeze([
      "reproduction or bounded failure evidence",
      "regression test",
      "post-fix verification",
    ]),
  }),
  Object.freeze({
    id: "tdd",
    title: "Test-driven implementation",
    signals: Object.freeze([
      "feature",
      "implement",
      "refactor",
      "fix",
      "behavior",
      "contract",
      "api",
      "parser",
      "adapter",
      "workflow",
    ]),
    workflow: Object.freeze([
      "state the behavioral contract",
      "add or identify a failing/coverage test",
      "implement the smallest coherent change",
      "run targeted tests then required merge gates",
    ]),
    evidence: Object.freeze([
      "behavioral test coverage",
      "targeted verification",
      "exact-head required CI",
    ]),
  }),
  Object.freeze({
    id: "release-readiness",
    title: "Release readiness",
    signals: Object.freeze([
      "release",
      "deploy",
      "publish",
      "package",
      "version",
      "marketplace",
      "distribution",
      "update",
      "installer",
      "artifact",
      "sbom",
      "provenance",
    ]),
    workflow: Object.freeze([
      "verify canonical version and product metadata",
      "build reproducible bounded artifacts",
      "scan credentials and produce supply-chain evidence",
      "separate repository readiness from owner/vendor publication gates",
    ]),
    evidence: Object.freeze([
      "package validation",
      "credential scan",
      "SBOM/provenance when applicable",
      "exact-head required CI",
    ]),
  }),
  Object.freeze({
    id: "search-visibility",
    title: "Technical SEO and search visibility",
    signals: Object.freeze([
      "seo",
      "sitemap",
      "robots",
      "canonical",
      "hreflang",
      "schema",
      "indexing",
      "metadata",
      "crawl",
      "pagespeed",
    ]),
    workflow: Object.freeze([
      "inventory approved public URLs and current indexability",
      "audit canonical, robots, metadata, sitemap, hreflang, and structured data",
      "prioritize verified fixes without inventing search rankings",
      "validate local SEO tests and obtain deployment approval",
    ]),
    evidence: Object.freeze([
      "source URLs and reproducible SEO findings",
      "metadata, schema, and sitemap validation",
      "targeted tests and exact-head CI",
    ]),
  }),
  Object.freeze({
    id: "ai-answer-visibility",
    title: "Evidence-led GEO and AI answer visibility",
    signals: Object.freeze([
      "geo",
      "aeo",
      "llms",
      "perplexity",
      "citations",
      "answerengine",
    ]),
    workflow: Object.freeze([
      "inventory verifiable product capabilities and first-party sources",
      "check crawlability and extractable on-page answers",
      "draft concise factual summaries with source attribution",
      "review for fabricated citations, unsupported metrics, and brand misclaims",
    ]),
    evidence: Object.freeze([
      "claim-to-source ledger",
      "crawlability and structured-data checks",
      "human-reviewed publication diff",
    ]),
  }),
  Object.freeze({
    id: "content-discovery",
    title: "Search-led content planning",
    signals: Object.freeze([
      "keyword",
      "keywords",
      "editorial",
      "copywriting",
      "content",
      "blog",
      "backlinks",
    ]),
    workflow: Object.freeze([
      "identify customer intent, geography, and product positioning",
      "research queries and competitor claims using attributed sources",
      "draft unique briefs, accessible copy, and internal-link opportunities",
      "keep speculative volumes or ranking promises out of published content",
    ]),
    evidence: Object.freeze([
      "source-linked research and intent grouping",
      "reviewed editorial brief or page diff",
      "content and link QA results",
    ]),
  }),
  Object.freeze({
    id: "conversion-measurement",
    title: "Conversion and analytics validation",
    signals: Object.freeze([
      "conversion",
      "conversions",
      "analytics",
      "ga4",
      "funnel",
      "attribution",
      "ctr",
      "signup",
    ]),
    workflow: Object.freeze([
      "verify consent, event definitions, and available data access",
      "compare complete time windows and flag tracking gaps",
      "inspect landing-page to signup and purchase experience",
      "prepare reversible improvements without enabling paid spend",
    ]),
    evidence: Object.freeze([
      "event and consent mapping",
      "dated, verifiable metrics or explicitly unavailable data",
      "reviewed conversion QA and tests",
    ]),
  }),
]);

const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ");

export const SKILL_PACKS = PACKS.map(({ signals, ...pack }) =>
  Object.freeze(pack),
);

export function selectSkillPacks({
  objective,
  changedFiles = [],
  failureSummary = "",
}) {
  const haystack = normalize(
    [objective, failureSummary, ...changedFiles].filter(Boolean).join(" "),
  );
  const tokens = new Set(haystack.split(" ").filter(Boolean));
  const selected = [];
  for (const pack of PACKS) {
    const matchedSignals = pack.signals.filter((signal) => tokens.has(signal));
    if (matchedSignals.length === 0) continue;
    selected.push({
      id: pack.id,
      title: pack.title,
      reasons: matchedSignals.slice(0, 6),
      workflow: [...pack.workflow],
      evidence: [...pack.evidence],
    });
  }
  return selected;
}
