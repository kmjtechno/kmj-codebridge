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
]);

const normalize = (value) =>
  value.toLowerCase().replace(/[^a-z0-9._/-]+/g, " ");

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
  const selected = [];
  for (const pack of PACKS) {
    const matchedSignals = pack.signals.filter((signal) =>
      haystack.includes(signal),
    );
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
