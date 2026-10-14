// Native, dependency-free pre-publication reviewer guard.
// Inspired by MIT-licensed affaan-m/ECC review, GateGuard and context handoff.
// This module never executes a patch, changes policy or auto-approves releases.
const MAX_FILES = 20;
const MAX_PATCH_CHARS = 96 * 1024;
const PATH = /^[A-Za-z0-9_.@+/-]{1,256}$/;
const RISK_RULES = Object.freeze([
  {
    id: "IDENTITY_OR_SECRETS",
    path: /(?:^|\/)(?:auth|oauth|login|identity|session|secrets?|credentials?|permissions?|security)(?:[./_-]|$)/i,
    gates: ["security", "negative-auth-tests"],
  },
  {
    id: "PAYMENTS_OR_LICENSING",
    path: /(?:^|\/)(?:payments?|billing|checkout|licens(?:e|ing)|entitlements?|webhooks?)(?:[./_-]|$)/i,
    gates: ["security", "commerce-integrity-tests"],
  },
  {
    id: "DEPLOY_OR_UPDATE",
    path: /(?:^|\/)(?:\.github\/workflows|deploy(?:ment)?|releases?|installers?|updaters?|scripts\/install|systemd)(?:[./_-]|$)/i,
    gates: ["signed-release-proof", "rollback-proof"],
  },
  {
    id: "AGENT_CONTROL_SURFACE",
    path: /(?:^|\/)(?:\.mcp\.json|AGENTS\.md|CLAUDE\.md|\.claude|hooks?|mcp-configs?|supervisor|polic(?:y|ies))(?:[./_-]|$)/i,
    gates: ["agent-permission-audit", "negative-auth-tests"],
  },
]);
const PATCH_RULES = Object.freeze([
  {
    id: "DYNAMIC_CODE_EXECUTION",
    pattern: /\b(?:eval\s*\(|new\s+Function\s*\(|child_process\b|execSync\s*\(|spawnSync\s*\()/i,
    gates: ["sandbox-and-command-allowlist"],
  },
  {
    id: "REMOTE_SCRIPT_PIPELINE",
    pattern: /(?:curl|wget)\b[^\n]{0,200}\|\s*(?:sudo\s+)?(?:bash|sh)\b/i,
    gates: ["supply-chain-review"],
  },
  {
    id: "BROAD_PRIVILEGE_CHANGE",
    pattern: /\b(?:chmod\s+(?:-R\s+)?777|--privileged|setenforce\s+0|disable[_-]?auth(?:entication)?|verify\s*:\s*false)\b/i,
    gates: ["negative-auth-tests"],
  },
]);

const unique = (values) => [...new Set(values)].sort();
const safeFiles = (files) =>
  Array.isArray(files) &&
  files.length > 0 &&
  files.length <= MAX_FILES &&
  new Set(files).size === files.length &&
  files.every(
    (name) =>
      typeof name === "string" &&
      PATH.test(name) &&
      !name.startsWith("/") &&
      !name.includes("//") &&
      !name.split("/").some((part) => part === "." || part === ".."),
  );

// Defensive classifier only: no patch content appears in results, and untrusted
// comments or prompts embedded in diffs cannot cause any host action.
export function reviewHarnessGuard({ files, patch = null } = {}) {
  if (!safeFiles(files)) throw new Error("HARNESS_GUARD_INVALID_FILES");
  if (patch !== null && (typeof patch !== "string" || patch.length > MAX_PATCH_CHARS))
    throw new Error("HARNESS_GUARD_INVALID_PATCH");
  const signals = [];
  const requiredGates = new Set(["exact-head-ci", "isolated-patch-verification"]);
  for (const name of files) {
    for (const rule of RISK_RULES) {
      if (!rule.path.test(name)) continue;
      signals.push(rule.id);
      for (const gate of rule.gates) requiredGates.add(gate);
    }
  }
  if (patch !== null) {
    // Only added lines are considered; never trust diff contents as instructions.
    const additions = patch
      .split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .map((line) => line.slice(1));
    for (const rule of PATCH_RULES) {
      if (!additions.some((line) => rule.pattern.test(line))) continue;
      signals.push(rule.id);
      for (const gate of rule.gates) requiredGates.add(gate);
    }
  }
  const riskSignals = unique(signals);
  return {
    risk: riskSignals.length > 0 ? "ELEVATED_MANUAL_REVIEW" : "STANDARD_MANUAL_REVIEW",
    signals: riskSignals,
    requiredGates: unique([...requiredGates]),
    inspection: patch === null ? "PATHS_ONLY" : "PATCH_ADDITIONS_AND_PATHS",
    autoPublish: false,
    nextAction:
      riskSignals.length > 0
        ? "INDEPENDENT_SECURITY_REVIEW_BEFORE_AUTHORIZED_PR"
        : "INDEPENDENT_PATCH_REVIEW_BEFORE_AUTHORIZED_PR",
  };
}

// Structured cross-agent handoff: a small, SHA-fenced record rather than
// persisting full patches, logs, prompts, credentials or untrusted instructions.
export function reviewHandoff({ expectedHead, patchSha256, verificationJobId, guard }) {
  if (
    !/^[a-f0-9]{40}$/.test(expectedHead ?? "") ||
    !/^[a-f0-9]{64}$/.test(patchSha256 ?? "") ||
    typeof verificationJobId !== "string" ||
    !/^[A-Za-z0-9_-]{1,80}$/.test(verificationJobId) ||
    !guard ||
    !Array.isArray(guard.requiredGates) ||
    !["STANDARD_MANUAL_REVIEW", "ELEVATED_MANUAL_REVIEW"].includes(guard.risk)
  ) throw new Error("HARNESS_HANDOFF_INVALID_EVIDENCE");
  return {
    stage: "REVIEW",
    sourceHead: expectedHead,
    patchSha256,
    verificationJobId,
    reviewRisk: guard.risk,
    requiredGates: [...guard.requiredGates],
    patchStorage: "ISOLATED_WORKTREE_ONLY",
    reviewStatus: "PENDING",
    publicationStatus: "NOT_PUBLISHED",
  };
}
