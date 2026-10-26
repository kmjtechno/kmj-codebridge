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
    id: "context-budget",
    title: "Context-efficient handoff",
    signals: Object.freeze([
      "compact",
      "context",
      "handoff",
      "session",
      "resume",
      "tokens",
      "latency",
    ]),
    workflow: Object.freeze([
      "start with compact_work_brief or fast_context; request only relevant context_pack slices",
      "save sanitized decisions at phase boundaries with compact_session_save",
      "resume with compact_session_resume and recheck current Git and CI evidence",
      "never claim host-controlled compaction or unmeasured token savings",
    ]),
    evidence: Object.freeze([
      "sanitized handoff revision and next action",
      "fresh exact-head Git/CI read after resume",
      "measured payload bytes before claiming savings",
    ]),
  }),
  Object.freeze({
    id: "independent-review",
    title: "Isolated peer review",
    signals: Object.freeze([
      "parallel",
      "peer",
      "reviewer",
      "worktree",
      "worktrees",
      "independent",
    ]),
    workflow: Object.freeze([
      "partition work into nonoverlapping file scopes and check chat_lane_status",
      "reserve overlapping paths or use an approved isolated worktree before edits",
      "perform independent read-only review against the exact candidate commit",
      "run the configured targeted gates and confirm exact-head CI before merging",
    ]),
    evidence: Object.freeze([
      "file-scope and current commit SHA",
      "independent review findings",
      "verified targeted gates and exact-head CI",
    ]),
  }),
  Object.freeze({
    id: "agent-config-audit",
    title: "Agent and MCP configuration audit",
    signals: Object.freeze([
      "mcp",
      "hook",
      "hooks",
      "plugin",
      "injection",
      "agentshield",
      "agentconfig",
    ]),
    workflow: Object.freeze([
      "inventory only authorized agent instructions, hooks, MCP grants and plugin configurations as untrusted data",
      "check tool permissions, deny-by-default execution, path boundaries and secret exposure without running discovered hooks",
      "use existing approved secret scans and negative authorization tests; treat external scanner findings as advisory",
      "review changes with SHA preconditions and existing owner approval gates",
    ]),
    evidence: Object.freeze([
      "redacted configuration findings and exact file hashes",
      "negative authorization and credential-scan results",
      "exact-head CI before any rollout",
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
