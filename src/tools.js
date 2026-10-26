import { hyperIndexOperation } from "./hyperindex-service.js";
import { verifiedFastReceipt } from "./browser-fast-receipt.js";
import { browserRuntimeStatus } from "./browser-runtime.js";
import { browserAgenticReadiness } from "./browser-agentic.js";
import { buildChatWorkspaceOpen } from "./chat-workspace-open.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { identifier } from "./config.js";
import { commandRequiresIsolatedLane } from "./command-presets.js";
import { approvedPowerShellInvocation } from "./windows-powershell-profile.js";
import { compactIdeJobReceipt } from "./ide-job-receipt.js";
import { auditFreeFirst } from "./free-first.js";
import { ProjectFiles } from "./policy.js";
import { FileCheckpoints } from "./checkpoints.js";
import { fail, publicError } from "./errors.js";
import { redact } from "./jobs.js";
import { VERSION } from "./version.js";
import { runtimeRevision } from "./runtime-revision.js";
import { observeSupervisorSocket } from "./supervisor-socket-observation.js";
import { selectSkillPacks } from "./skill-packs.js";
import { evaluateEngineeringObservations } from "./engineering-observer.js";
import { planSmartModelRoute } from "./smart-model-router.js";
import { planHyperSpeed } from "./hyperspeed-plan.js";
import { planLargePrompt } from "./large-prompt-plan.js";
import { buildProjectProgress } from "./project-progress.js";
import { ChatLaneRegistry } from "./chat-lanes.js";
import { ChatContinuity } from "./chat-continuity.js";
import { CompactSessionStore } from "./compact-session.js";
import { AgentCoordination } from "./agent-coordination.js";
import { createLocalModelClient } from "./local-model.js";
import { localModelReceipt, unknownModelReceipt } from "./model-attribution.js";
import { WorktreeLanes } from "./worktree-lanes.js";
import { canQueueAutopilotGate } from "./autopilot-gate-worker.js";
import { reviewRepairCandidate } from "./autopilot-repair-review.js";
import {
  inspectBlockers,
  isTrustedWindowsSupervisorStatus,
  BLOCKER_CODES,
  remediationTaskForBlocker,
} from "./blocker-recovery.js";

// Structured sensitive-binding comparison for write protection.
//
// Checking only whether a secret's raw characters still appear somewhere in
// the new content is not enough: the bytes can be relocated into a comment
// or an unrelated string literal (destroying the binding while the
// characters themselves survive), or one of several identical occurrences
// can be dropped while another remains, and a simple substring check would
// not catch either case. Each sensitive occurrence is instead normalized
// into a (kind, key, value) binding, and before/after file contents are
// compared as MULTISETS: every binding must survive with the same identity
// and the same occurrence count. These patterns mirror redact()'s in
// jobs.js exactly (same text, same flags) so a value only ever counts as
// "sensitive" here when redact() would also mask it there.
const BEARER_BINDING = /Bearer\s+([A-Za-z0-9._~+\/-]+)/gi;
const KEY_VALUE_BINDING =
  /(password|secret|token|api[_-]?key)\s*[=:]\s*([^\s,;]+)/gi;
const PRIVATE_KEY_BINDING =
  /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g;

export function sensitiveBindings(text) {
  const bindings = [];
  for (const match of text.matchAll(BEARER_BINDING))
    bindings.push(["bearer", match[1]]);
  for (const match of text.matchAll(KEY_VALUE_BINDING))
    bindings.push([
      "kv",
      match[1].toLowerCase().replace(/[-_]/g, ""),
      match[2],
    ]);
  for (const match of text.matchAll(PRIVATE_KEY_BINDING))
    bindings.push(["private-key", match[0]]);
  return bindings;
}

// True only when every sensitive binding present in `before` still occurs
// in `after` at least as many times â a strict multiset subset check. This
// rejects relocating a bound value into a comment or an unrelated string
// (the binding disappears even though the raw bytes remain somewhere),
// moving a value from one label to another (same value, different key, so
// a different binding identity), silently dropping one of several
// duplicate occurrences (the per-binding count), and any partial or
// truncated change to the value itself. It never blocks an edit elsewhere
// in the file, and harmless whitespace around a binding's separator never
// changes that binding's identity.
export function preservesSensitiveBindings(before, after) {
  const remaining = new Map();
  for (const binding of sensitiveBindings(after)) {
    const key = JSON.stringify(binding);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const binding of sensitiveBindings(before)) {
    const key = JSON.stringify(binding);
    const count = remaining.get(key) ?? 0;
    if (count < 1) return false;
    remaining.set(key, count - 1);
  }
  return true;
}
function detectProjectEnvironment(files) {
  const listing = files.list("");
  const names = new Set(listing.entries.map((entry) => entry.name));
  const stacks = new Set();
  const frameworks = new Set();
  const packageManagers = new Set();
  const manifests = new Set();
  const mark = (name, stack, packageManager = null) => {
    if (!names.has(name)) return;
    manifests.add(name);
    if (stack) stacks.add(stack);
    if (packageManager) packageManagers.add(packageManager);
  };

  mark("package.json", "node");
  mark("composer.json", "php", "composer");
  mark("Cargo.toml", "rust", "cargo");
  mark("pyproject.toml", "python");
  mark("requirements.txt", "python", "pip");
  mark("Pipfile", "python", "pipenv");
  mark("go.mod", "go", "go");
  mark("pom.xml", "java", "maven");
  mark("build.gradle", "java", "gradle");
  mark("build.gradle.kts", "java", "gradle");
  mark("Gemfile", "ruby", "bundler");
  mark("Dockerfile", "docker", "docker");
  mark("compose.yaml", "docker", "docker");
  mark("compose.yml", "docker", "docker");
  mark("docker-compose.yml", "docker", "docker");
  mark("docker-compose.yaml", "docker", "docker");

  if (
    listing.entries.some(
      (entry) =>
        entry.type === "file" &&
        (entry.name.endsWith(".csproj") || entry.name.endsWith(".sln")),
    )
  )
    stacks.add("dotnet");

  if (names.has("pnpm-lock.yaml")) packageManagers.add("pnpm");
  if (names.has("package-lock.json")) packageManagers.add("npm");
  if (names.has("yarn.lock")) packageManagers.add("yarn");
  if (names.has("bun.lock") || names.has("bun.lockb"))
    packageManagers.add("bun");

  if (names.has("artisan")) frameworks.add("laravel");
  if (names.has("manage.py")) frameworks.add("django");
  if (
    ["next.config.js", "next.config.mjs", "next.config.ts"].some((name) =>
      names.has(name),
    )
  )
    frameworks.add("nextjs");
  if (
    ["vite.config.js", "vite.config.mjs", "vite.config.ts"].some((name) =>
      names.has(name),
    )
  )
    frameworks.add("vite");

  if (names.has("src-tauri")) {
    try {
      const tauri = new Set(
        files.list("src-tauri").entries.map((entry) => entry.name),
      );
      if (tauri.has("tauri.conf.json") || tauri.has("Cargo.toml")) {
        frameworks.add("tauri");
        stacks.add("rust");
      }
    } catch {}
  }

  if (names.has("package.json")) {
    try {
      const pkg = JSON.parse(files.read("package.json").content);
      const deps = {
        ...(pkg?.dependencies ?? {}),
        ...(pkg?.devDependencies ?? {}),
      };
      if (Object.hasOwn(deps, "react")) frameworks.add("react");
      if (Object.hasOwn(deps, "vue")) frameworks.add("vue");
      if (Object.hasOwn(deps, "svelte")) frameworks.add("svelte");
      if (Object.hasOwn(deps, "@angular/core")) frameworks.add("angular");
      if (Object.hasOwn(deps, "express")) frameworks.add("express");
      if (Object.hasOwn(deps, "@nestjs/core")) frameworks.add("nestjs");
      if (Object.hasOwn(deps, "next")) frameworks.add("nextjs");
      if (Object.hasOwn(deps, "vite")) frameworks.add("vite");
    } catch {}
  }

  if (names.has("composer.json")) {
    try {
      const composer = JSON.parse(files.read("composer.json").content);
      const deps = {
        ...(composer?.require ?? {}),
        ...(composer?.["require-dev"] ?? {}),
      };
      if (Object.hasOwn(deps, "laravel/framework")) frameworks.add("laravel");
      if (Object.keys(deps).some((name) => name.startsWith("symfony/")))
        frameworks.add("symfony");
    } catch {}
  }

  return {
    stacks: [...stacks].sort(),
    frameworks: [...frameworks].sort(),
    packageManagers: [...packageManagers].sort(),
    manifests: [...manifests].sort(),
  };
}

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".kts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc"]);
const CONFIG_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "composer.json",
  "composer.lock",
  "cargo.toml",
  "cargo.lock",
  "pyproject.toml",
  "requirements.txt",
  "pipfile",
  "pipfile.lock",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gemfile",
  "gemfile.lock",
  "dockerfile",
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
]);

function classifyChangedPath(relative) {
  const normalized = String(relative).replaceAll("\\", "/").toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  const ext = path.posix.extname(base);
  if (
    normalized.startsWith(".github/") ||
    normalized.startsWith(".gitlab/") ||
    normalized.includes("/.github/")
  )
    return "ci";
  if (
    CONFIG_BASENAMES.has(base) ||
    normalized.startsWith("config/") ||
    normalized.includes("/config/") ||
    normalized.startsWith("migrations/") ||
    normalized.includes("/migrations/")
  )
    return "config";
  if (
    normalized.startsWith("docs/") ||
    normalized.includes("/docs/") ||
    DOC_EXTENSIONS.has(ext)
  )
    return "docs";
  if (
    normalized.startsWith("test/") ||
    normalized.startsWith("tests/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes("/__tests__/") ||
    /(?:^|\.)((test|spec))\.[^.]+$/.test(base)
  )
    return "tests";
  if (SOURCE_EXTENSIONS.has(ext)) return "source";
  if ([".gif", ".ico", ".jpeg", ".jpg", ".png", ".svg", ".webp"].includes(ext))
    return "assets";
  return "other";
}

function gateRole(id) {
  const name = String(id).toLowerCase();
  if (/security|audit|scan|sast|dependency/.test(name)) return "security";
  if (/integration|e2e|end.?to.?end|smoke|accept/.test(name))
    return "integration";
  if (/unit/.test(name)) return "unit";
  if (/test|spec|pytest/.test(name)) return "test";
  if (/type|tsc|static|phpstan|psalm|mypy|clippy/.test(name)) return "type";
  if (/lint|format|style|checkstyle/.test(name)) return "lint";
  if (/build|compile|package|bundle/.test(name)) return "build";
  if (/docs|markdown|spell/.test(name)) return "docs";
  if (/check|verify|validate/.test(name)) return "check";
  return "other";
}

export function selectVerificationPlan({
  changedPaths = [],
  gates = [],
  gitAvailable = true,
  truncated = false,
  environment = {},
} = {}) {
  const allGates = [...new Set(gates)].sort();
  const counts = {
    source: 0,
    tests: 0,
    docs: 0,
    config: 0,
    ci: 0,
    assets: 0,
    other: 0,
  };
  for (const relative of changedPaths)
    counts[classifyChangedPath(relative)] += 1;

  const changeCount = Object.values(counts).reduce(
    (sum, value) => sum + value,
    0,
  );
  const roles = new Map(allGates.map((gate) => [gate, gateRole(gate)]));
  const byRoles = (...wanted) =>
    allGates.filter((gate) => wanted.includes(roles.get(gate)));
  const unique = (items) => [...new Set(items)];

  let mode = "none";
  let recommendedGates = [];
  const reasonCodes = [];
  let requireFullBeforeRelease = false;

  if (!allGates.length) {
    mode = "unavailable";
    reasonCodes.push("NO_CONFIGURED_GATES");
  } else if (!gitAvailable || truncated) {
    mode = "full";
    recommendedGates = allGates;
    reasonCodes.push(
      !gitAvailable ? "CHANGE_SCOPE_UNKNOWN" : "CHANGE_SCOPE_TRUNCATED",
    );
  } else if (changeCount === 0) {
    reasonCodes.push("NO_WORKTREE_CHANGES");
  } else if (counts.config > 0 || counts.ci > 0 || counts.other > 0) {
    mode = "full";
    recommendedGates = allGates;
    if (counts.config > 0) reasonCodes.push("CONFIG_OR_DEPENDENCY_CHANGE");
    if (counts.ci > 0) reasonCodes.push("CI_CHANGE");
    if (counts.other > 0) reasonCodes.push("UNCLASSIFIED_CHANGE");
  } else {
    mode = "targeted";
    requireFullBeforeRelease = true;
    if (counts.source > 0) {
      reasonCodes.push("SOURCE_CHANGE");
      recommendedGates.push(
        ...byRoles("lint", "type", "unit", "test", "check"),
      );
    }
    if (counts.tests > 0) {
      reasonCodes.push("TEST_CHANGE");
      recommendedGates.push(...byRoles("unit", "test", "integration", "check"));
    }
    if (counts.docs > 0) {
      reasonCodes.push("DOCS_CHANGE");
      recommendedGates.push(...byRoles("docs", "lint", "check"));
    }
    if (counts.assets > 0) {
      reasonCodes.push("ASSET_CHANGE");
      recommendedGates.push(...byRoles("build", "test", "check"));
    }
    recommendedGates = unique(recommendedGates);
    if (!recommendedGates.length) {
      recommendedGates = allGates;
      mode = "full";
      requireFullBeforeRelease = false;
      reasonCodes.push("NO_TARGETED_GATE_MATCH");
    }
  }

  return {
    mode,
    changeCount,
    changeClasses: counts,
    recommendedGates,
    fullGates: allGates,
    requireFullBeforeRelease,
    reasonCodes,
    stacks: [...(environment.stacks ?? [])],
    frameworks: [...(environment.frameworks ?? [])],
  };
}

function collectChangedPaths(root) {
  const gitDir = path.join(root, ".git");
  try {
    const stat = fs.lstatSync(gitDir);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return { gitAvailable: false, paths: [], truncated: false };
    const output = execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 65536,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
        },
      },
    );
    const records = output.split("\0");
    const paths = [];
    const seen = new Set();
    let truncated = false;
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record || record.length < 4) continue;
      const status = record.slice(0, 2);
      let relative = record.slice(3).replaceAll("\\", "/");
      if (!relative || seen.has(relative)) continue;
      seen.add(relative);
      paths.push(relative);
      if (paths.length >= 500) {
        truncated = true;
        break;
      }
      if (/[RC]/.test(status) && i + 1 < records.length) {
        const previous = records[++i]?.replaceAll("\\", "/");
        if (previous && !seen.has(previous)) {
          seen.add(previous);
          paths.push(previous);
          if (paths.length >= 500) {
            truncated = true;
            break;
          }
        }
      }
    }
    return { gitAvailable: true, paths, truncated };
  } catch {
    return { gitAvailable: false, paths: [], truncated: false };
  }
}

const RISK_CLASSES = [
  "READ",
  "TEST",
  "EDIT",
  "GIT_WRITE",
  "SERVICE",
  "DEPLOY",
  "PRIVILEGED",
  "DESTRUCTIVE",
];

const CLOUDOS_HOST_STORAGE_AUDIT_PYTHON = [
  "import socket,subprocess,sys",
  "if socket.gethostname().split('.')[0] != 'google-vps1': sys.exit('WRONG_HOST')",
  "checks = (",
  " ('DISK', ('df','-h','/'), True),",
  " ('HOME_TOP', ('du','-xhd1','/home/info'), False),",
  " ('CACHE', ('du','-xsh','/home/info/.cache','/home/info/.npm','/home/info/.local/share/Trash'), False),",
  " ('HOST_DIRS', ('du','-xhd1','/var/lib','/var/log','/var/backups','/tmp'), False),",
  " ('SERVICES', ('systemctl','is-active','kmj-cloudos-api.service','kmj-cloudos-worker.service','kmj-codebridge-cloudos.service'), True),",
  ")",
  "critical_failed = False",
  "partial = False",
  "for name,argv,critical in checks:",
  " print('=== '+name+' ===',flush=True)",
  " try:",
  "  p=subprocess.run(argv,capture_output=True,text=True,timeout=45,check=False,env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C'})",
  "  for line in p.stdout.splitlines()[:60]: print(line[:240])",
  "  passed=p.returncode == 0",
  "  if name == 'SERVICES' and p.stdout.splitlines() != ['active','active','active']: passed=False",
  "  print('READ_ONLY_CHECK_'+name+'='+('PASS' if passed else 'BLOCKED' if critical else 'PARTIAL'),flush=True)",
  "  if not passed:",
  "   if critical: critical_failed=True",
  "   else: partial=True",
  " except (OSError,subprocess.TimeoutExpired):",
  "  print('READ_ONLY_CHECK_'+name+'='+('BLOCKED' if critical else 'PARTIAL'),flush=True)",
  "  if critical: critical_failed=True",
  "  else: partial=True",
  "print('CLOUDOS_HOST_STORAGE_AUDIT='+('BLOCKED' if critical_failed else 'PARTIAL' if partial else 'PASS'),flush=True)",
  "sys.exit(1 if critical_failed else 0)",
].join("\n");

function commandRisk(category) {
  return (
    {
      inspect: "READ",
      build: "TEST",
      write: "EDIT",
      network: "SERVICE",
    }[category] ?? "PRIVILEGED"
  );
}

function toolRisk(name, definition) {
  if (definition.access === "read") return "READ";
  if (name === "supervisor_main_platform_production_activate") return "DEPLOY";
  if (name === "run_quality_gate") return "TEST";
  if (
    name === "worktree_lane_prepare" ||
    name === "worktree_lane_prepare_cached_main"
  )
    return "GIT_WRITE";
  if (name === "worktree_lane_cleanup") return "DESTRUCTIVE";
  if (
    ["write_file", "edit_file", "write_files_atomic", "cancel_job"].includes(
      name,
    )
  )
    return "EDIT";
  if (definition.access === "write") return "EDIT";
  return "SERVICE";
}

function approvalRequired(risk) {
  return ["DEPLOY", "PRIVILEGED", "DESTRUCTIVE"].includes(risk);
}

const scoped = { device: identifier, project: identifier };
// Same lane id grammar as src/worktree-lanes.js.
const laneIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/);
const supervisorService = z.enum(["agent", "gateway"]);
const contextBudget = z.enum(["small", "medium", "deep"]);
export const FAST_READ_TOOLS = [
  "inspect_project",
  "connection_doctor",
  "project_environment",
  "policy_catalog",
  "audit_status",
  "audit_tail",
  "execution_capacity",
  "project_progress",
  "chat_lane_status",
  "chat_continuity_read",
  "coordination_list",
  "local_model_status",
  "worktree_lane_status",
  "verification_plan",
  "project_snapshot",
  "workspace_home",
  "list_directory",
  "project_tree",
  "project_integrity_manifest",
  "project_file_info",
  "checkpoint_restore_plan",
  "list_project_jobs",
  "repo_map",
  "repo_intelligence",
  "context_pack",
  "git_status",
  "git_diff",
  "git_log",
  "git_show",
  "git_index_probe",
  "search_code",
  "skill_recommendations",
  "model_route_plan",
  "read_file",
  "read_file_tail",
  "read_file_range",
  "read_files_batch",
  "autopilot_status",
  "supervisor_status",
  "supervisor_config_validate",
  "supervisor_disk_space",
  "supervisor_project_status",
  "supervisor_device_status",
];
const fastReadTool = z.enum(FAST_READ_TOOLS);
const file = { ...scoped, path: z.string().min(1).max(1024) };
const patch = {
  ...file,
  leaseToken: z.string().uuid().optional(),
  content: z.string().max(262144),
  expectedHash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
};
export const definitions = {
  list_devices: {
    title: "List authorized devices",
    description: "List devices and projects authorized for this account.",
    input: {},
    access: "read",
  },
  account_diagnostics: {
    title: "Account diagnostics",
    description:
      "Read safe CodeBridge account membership, device-grant, and same-tenant agent visibility diagnostics without returning credentials.",
    input: {},
    access: "read",
  },
  compact_work_brief: {
    title: "Compact CodeBridge work brief",
    description:
      "Token-efficient project briefing: bounded Git identity, task counts, next task ID and actually available approved job slots. No raw files, logs, prompts, credentials, token-usage guarantees or unverified completion estimates.",
    input: {
      ...scoped,
    },
    access: "read",
  },
  multi_chat_sync: {
    title: "HyperSpeed multi-chat project sync",
    description:
      "Read one bounded project-lane continuity checkpoint plus compact live Git/tasks/locks/mailbox context in a single chat tool call. Supply ifNoneMatch for tiny unchanged replies. Works across independently granted ChatGPT chats, but does not wake inactive host chats or extend the host context window.",
    input: {
      ...scoped,
      lane: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
      ifNoneMatch: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    access: "read",
  },
  context_resume: {
    title: "Resume engineering context",
    description:
      "Pass ifNoneMatch (the digest from a previous packet) to get a tiny unchanged answer when nothing changed. One compact, versioned packet to continue work: Git branch/dirty state, top open tasks, active file reservations, last five project mailbox notes (caller claims) and approved job slots. Unreadable parts are UNKNOWN, never guessed. No raw files, logs or credentials.",
    input: {
      ...scoped,
      ifNoneMatch: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    access: "read",
  },
  render_codebridge_status: {
    title: "Open KMJ Mission Control",
    description:
      "Open premium KMJ Mission Control with verified tasks and receipts. Optionally include an authorized read-only file tree and tracked Git diff in the Workspace tab. Missing data stays UNKNOWN. Does not write files or execute arbitrary commands; text-only clients keep a compact status.",
    input: {
      ...scoped,
      includeWorkspace: z.boolean().default(false),
    },
    access: "read",
  },
  fleet_overview: {
    title: "Fleet project progress",
    description:
      "Read a bounded cross-device status of account-authorized CodeBridge projects, their actual queue and capacity, and next action. No shell, AI execution, account-plan change, or release claim.",
    input: {
      maxProjects: z.number().int().min(1).max(12).default(8),
    },
    access: "read",
  },
  connection_overview: {
    title: "Check my CodeBridge connections",
    description:
      "One-step account-safe connection doctor: distinguish missing device grant, missing gateway registration, project grant mismatch and offline agent without reconnecting OAuth or exposing credentials.",
    input: {
      expectedDevice: identifier.optional(),
      expectedProject: identifier.optional(),
    },
    access: "read",
  },
  inspect_project: {
    title: "Inspect project",
    description: "Inspect an authorized project and configured quality gates.",
    input: scoped,
    access: "read",
  },
  project_environment: {
    title: "Detect project environment",
    description:
      "Detect bounded project stacks, common frameworks, package managers, and top-level manifests without executing project code.",
    input: scoped,
    access: "read",
  },
  free_first_audit: {
    title: "Free-first spend audit",
    description:
      "Read-only advisory scan of the project's CI configuration (GitHub workflows, CircleCI) for settings that may consume paid minutes or metered services, each with a legal free alternative. Reads repository configuration text only; never executes anything, contacts a provider or reads any provider secret store. Findings never echo repository lines (only fixed text, parsed tokens or allow-listed values) and output redaction is best-effort, because committed workflow text could itself contain a literal secret.",
    input: scoped,
    access: "read",
  },
  policy_catalog: {
    title: "CodeBridge policy catalog",
    description:
      "Read deterministic risk classes and approval metadata for CodeBridge tools and configured project command profiles without exposing raw commands.",
    input: scoped,
    access: "read",
  },
  audit_status: {
    title: "Audit ledger status",
    description:
      "Verify and read bounded integrity status for the authorized project's tamper-evident audit ledger.",
    input: scoped,
    access: "read",
  },
  audit_tail: {
    title: "Audit ledger tail",
    description:
      "Verify and read up to 100 recent secret-free audit evidence records for the authorized project.",
    input: {
      ...scoped,
      limit: z.number().int().min(1).max(100).default(20),
    },
    access: "read",
  },
  large_prompt_plan: {
    title: "Lossless large-prompt fast-path manifest",
    description:
      "Opt-in project-scoped read-only planning for up to 1 MiB of caller-authorized prompt text. Returns only ordered UTF-16 spans, SHA-256 integrity receipts, Markdown fence risk and existing fast-tool recommendations; never echoes/stores prompt text, calls AI, extends ChatGPT context or executes work. Client must retain the original text.",
    input: {
      ...scoped,
      prompt: z.string().min(1).max(1048576),
      chunkChars: z.number().int().min(8192).max(32768).default(16384),
      ifNoneMatch: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .default(null),
    },
    access: "read",
  },
  hyperspeed_plan: {
    title: "HyperSpeed free agent wave planner",
    description:
      "Model a bounded DAG of up to 64 logical agent tasks, constrained by actual licensed CodeBridge slots, file locks, dependency order and caller-supplied free model pools. Zero inference or execution. Provider quotas remain unverified until connected and authenticated.",
    input: {
      ...scoped,
      allowLocal: z.boolean().default(false),
      tasks: z
        .array(
          z
            .object({
              id: identifier,
              kind: z.enum(["research", "code", "test", "review", "docs"]),
              dependsOn: z.array(identifier).max(64).default([]),
              paths: z.array(z.string().min(1).max(200)).max(32).default(["*"]),
              estimateMinutes: z.number().int().min(1).max(240).default(30),
              priority: z.number().int().min(0).max(100).default(50),
              dataClass: z.enum(["public", "private"]).default("private"),
            })
            .strict(),
        )
        .min(1)
        .max(64),
      pools: z
        .array(
          z
            .object({
              id: identifier,
              kinds: z
                .array(z.enum(["research", "code", "test", "review", "docs"]))
                .max(5),
              enabled: z.boolean(),
              mode: z.enum(["cloud", "local"]),
              canProcessPrivateCode: z.boolean(),
              quotaVerified: z.boolean().default(false),
              remainingRequests: z.number().int().min(0).max(1000000),
              requestsPerMinute: z.number().int().min(1).max(100000),
              unitCostUsd: z.number().min(0).max(100),
            })
            .strict(),
        )
        .max(12),
    },
    access: "read",
  },
  project_progress: {
    title: "Project progress and next action",
    description:
      "Read a project-scoped, redacted progress summary from persisted autopilot tasks and controlled job sessions. Shows precise tracked-task completion, failed jobs, next ready task, and evidence limitations without claiming whole-project or production-release readiness.",
    input: {
      ...scoped,
      recentJobs: z.number().int().min(1).max(20).default(8),
    },
    access: "read",
  },
  coordination_list: {
    title: "Read project agent coordination mailbox",
    description:
      "List bounded notes and replies from authorized project agents: issues, blockers, proposals, handoffs and reported test outcomes. Actor names and PASS/FAIL are caller-reported, not attested. No background work or worker starts.",
    input: {
      ...scoped,
      limit: z.number().int().min(1).max(50).default(25),
      after: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .default(null),
    },
    access: "read",
  },
  coordination_post: {
    title: "Send project agent coordination note",
    description:
      "Post one sanitized, idempotent project-scoped issue, proposal, handoff or result for another authorized CodeBridge agent/chat. No code edit, shell, cloud call or automatic task claim.",
    input: {
      ...scoped,
      actor: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
      recipient: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/)
        .default("all"),
      requestKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
      kind: z.enum(["issue", "analysis", "proposal", "handoff", "result"]),
      note: z.string().min(1).max(500),
      replyTo: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable()
        .default(null),
      evidenceSha: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable()
        .default(null),
      reportedGate: z
        .enum(["unknown", "pass", "fail", "blocked"])
        .default("unknown"),
    },
    access: "write",
  },
  compact_session_save: {
    title: "Compact current engineering session (durable checkpoint)",
    description:
      "Save a bounded structured, caller-authored session handoff for one authorized project/chat lane. Keeps objective, locked decisions and constraints, unverified evidence references, blockers and next steps. Rejects secrets, transcript dumps and stale revisions. Does not alter ChatGPT's model context window or automatically read chat history.",
    input: {
      ...scoped,
      lane: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
      requestKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
      expectedRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      objective: z.string().min(1).max(240),
      summary: z.string().min(1).max(1800),
      decisions: z.array(z.string().min(1).max(200)).max(10).default([]),
      constraints: z.array(z.string().min(1).max(200)).max(12).default([]),
      evidence: z.array(z.string().min(1).max(180)).max(10).default([]),
      blockers: z.array(z.string().min(1).max(160)).max(8).default([]),
      nextSteps: z.array(z.string().min(1).max(180)).min(1).max(6),
    },
    access: "write",
  },
  compact_session_resume: {
    title: "Resume compact engineering session",
    description:
      "Get a portable, versioned, caller-reported, concise handoff for an authorized project/chat lane. Supply ifNoneMatch for an unchanged-only reply. No secrets, ChatGPT history access, automatic wake, or claims of increased model context window.",
    input: {
      ...scoped,
      lane: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
      ifNoneMatch: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    },
    access: "read",
  },
  chat_continuity_read: {
    title: "Read durable chat continuity checkpoint",
    description:
      "Read a bounded, versioned, untrusted project-and-lane context summary saved by authorized clients. Never a full chat transcript, automatic chat wake or verified task completion.",
    input: {
      ...scoped,
      lane: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
    },
    access: "read",
  },
  chat_continuity_save: {
    title: "Save guarded chat continuity checkpoint",
    description:
      "Persist a sanitized, small next-steps summary for one authorized project/chat lane. Requires optimistic revision precondition and idempotency key to prevent lost multi-chat updates; host write approval still applies. Never saves chat transcripts, code or secrets.",
    input: {
      ...scoped,
      lane: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
      requestKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/),
      expectedRevision: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
      summary: z.string().min(1).max(1000),
      next: z.string().min(1).max(500),
      blockers: z.array(z.string().min(1).max(120)).max(6).default([]),
    },
    access: "write",
  },
  chat_lane_status: {
    title: "Multi-chat work lane status",
    description:
      "List only this authorized project's active collaboration file reservations; never returns lease tokens or private chat content.",
    input: scoped,
    access: "read",
  },
  chat_lane_reserve: {
    title: "Reserve files for a chat lane",
    description:
      "Reserve exact project-relative files or directories for one chat work lane with an expiring idempotent lease. Prevents conflicting CodeBridge edits without blocking unrelated chats. Not a new execution or model quota.",
    input: {
      ...scoped,
      requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      paths: z.array(z.string().min(1).max(512)).min(1).max(20),
      ttlSeconds: z.number().int().min(60).max(3600).default(900),
    },
    access: "write",
  },
  chat_lane_release: {
    title: "Release my chat work lane",
    description:
      "Release a project-scoped reservation by its opaque token. Does not terminate other chats or background jobs.",
    input: { ...scoped, leaseToken: z.string().uuid() },
    access: "write",
  },
  local_model_status: {
    title: "Check offline AI model runtime",
    description:
      "Probe only the current device's loopback Ollama API, report bounded installed local models and readiness; never downloads models, contacts external AI providers or starts a service.",
    input: scoped,
    access: "read",
  },
  local_model_generate: {
    title: "Generate with a locally installed offline model",
    description:
      "Opt-in bounded prompt to an already-running loopback Ollama model on the authorized device, with no cloud or paid fallback. The model is unloaded after generation; output is untrusted text, not executable code.",
    input: {
      ...scoped,
      model: z.string().regex(/^[A-Za-z0-9._:/-]{1,96}$/),
      prompt: z.string().min(1).max(4096),
      maxTokens: z.number().int().min(16).max(512).default(192),
      timeoutSeconds: z.number().int().min(5).max(90).default(45),
      localProcessingApproved: z.literal(true),
    },
    access: "execute",
  },
  worktree_lane_prepare_cached_main: {
    title: "Prepare latest cached main in an isolated worktree",
    description:
      "Create a detached isolated lane at exactly the caller-verified origin/main SHA already cached locally. Never fetches, resets, cleans, or modifies the shared checkout; stale remote refs fail closed.",
    input: {
      ...scoped,
      laneId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/),
      expectedRemoteHead: z.string().regex(/^[a-f0-9]{40}$/),
      approveLocalGitCheckout: z.literal(true),
    },
    access: "execute",
  },
  worktree_lane_status: {
    title: "Read isolated coding worktrees",
    description:
      "List at most four detached, exact-head Git worktrees in the authorized project's private agent-state folder. No external service.",
    input: scoped,
    access: "read",
  },
  worktree_lane_prepare: {
    title: "Prepare isolated coding worktree",
    description:
      "Explicitly prepare one detached worktree from the authorized project's exact HEAD, without changing main checkout. No cloud or unrestricted shell; repository filters may execute during checkout.",
    input: {
      ...scoped,
      laneId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/),
      expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
      approveLocalGitCheckout: z.literal(true),
    },
    access: "execute",
  },
  worktree_lane_cleanup: {
    title: "Remove unchanged isolated coding worktree",
    description:
      "Explicitly remove only the named pristine disposable worktree at the pinned HEAD; rejects tracked or untracked changes, new commits and path tricks; never force-deletes.",
    input: {
      ...scoped,
      laneId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/),
      confirmLaneId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/),
      expectedHead: z.string().regex(/^[a-f0-9]{40}$/),
    },
    access: "execute",
  },
  execution_capacity: {
    title: "Execution capacity",
    description:
      "Read bounded resource-aware job capacity for the authorized project, including memory, disk, CPU load, active/queued jobs, and effective concurrency.",
    input: scoped,
    access: "read",
  },
  verification_plan: {
    title: "Smart verification plan",
    description:
      "Select deterministic targeted or full configured quality gates from bounded Git change classes and detected project stacks without executing repository code.",
    input: scoped,
    access: "read",
  },
  project_snapshot: {
    title: "Project snapshot",
    description:
      "Read project capabilities, a bounded top-level directory map, and Git working-tree status in one round trip.",
    input: {
      ...scoped,
      maxEntries: z.number().int().min(1).max(100).default(50),
    },
    access: "read",
  },
  chat_workspace_open: {
    title: "Open or resume a local-first AI chat workspace",
    description:
      "One-call, read-only CodeBridge workspace for ordinary ChatGPT, Claude, Gemini, IDE or MCP chat clients: bounded authorized file explorer, frameworks, quality gates, recent job/task evidence, optional chat-lane checkpoint and local browser readiness. Use ifNoneMatch for an unchanged-only reply. No host transcript access, wake-up, autonomous approval, paid inference or unrestricted browser control.",
    input: {
      ...scoped,
      lane: z
        .string()
        .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/)
        .default("main"),
      ifNoneMatch: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      maxEntries: z.number().int().min(5).max(40).default(30),
      recentJobs: z.number().int().min(1).max(8).default(5),
    },
    access: "read",
  },
  workspace_home: {
    title: "Open my CodeBridge workspace",
    description:
      "Show project identity, detected stacks, safe file explorer and recent project-owned sessions in one read-only view. No system shell, credential access or changes.",
    input: {
      ...scoped,
      maxDepth: z.number().int().min(0).max(3).default(2),
      maxEntries: z.number().int().min(5).max(100).default(50),
      recentJobs: z.number().int().min(1).max(20).default(5),
    },
    access: "read",
  },
  fast_context: {
    title: "Fast project context",
    description:
      "Read project metadata, Git status, and bounded autopilot state through one MCP call. The gateway composes existing read-only agent tools so older agents can benefit without a runtime upgrade.",
    input: {
      ...scoped,
      autopilotLimit: z.number().int().min(1).max(20).default(10),
    },
    access: "read",
  },
  fast_read_batch: {
    title: "Fast read batch",
    description:
      "Run up to eight allowlisted read-only checks through one MCP call. Choose responseMode=auto for adaptive byte-saving summaries on large read results while keeping small results intact; responseMode=compact always returns SHA-256 receipts and safe hints. Default full preserves legacy behavior; no result details are cached.",
    input: {
      ...scoped,
      responseMode: z.enum(["full", "compact", "auto"]).default("full"),
      calls: z
        .array(
          z.object({
            key: identifier,
            tool: fastReadTool,
            args: z.record(z.unknown()).default({}),
          }),
        )
        .min(1)
        .max(8),
    },
    access: "read",
  },
  list_directory: {
    title: "List directory",
    description:
      "List up to 500 non-sensitive entries in one directory inside an authorized project.",
    input: { ...scoped, path: z.string().max(1024).default("") },
    access: "read",
  },
  project_tree: {
    title: "Explore project folders",
    description:
      "Browse a bounded, recursive tree of approved project files and directories without listing hidden secrets, following symlinks, or leaving the authorized root.",
    input: {
      ...scoped,
      path: z.string().max(1024).default(""),
      maxDepth: z.number().int().min(0).max(5).default(3),
      maxEntries: z.number().int().min(1).max(200).default(100),
    },
    access: "read",
  },
  project_integrity_manifest: {
    title: "Project file integrity manifest",
    description:
      "Read a deterministic bounded summary of approved text file SHA-256 hashes, byte counts, and coverage without transferring source contents, touching Git index, or executing project code. Partial scans are explicitly marked.",
    input: {
      ...scoped,
      path: z.string().max(1024).default(""),
      maxDepth: z.number().int().min(0).max(5).default(2),
      maxFiles: z.number().int().min(1).max(60).default(40),
    },
    access: "read",
  },
  project_file_info: {
    title: "Project file details",
    description:
      "Read safe file metadata (size and modified date) from one authorized project file without returning file contents.",
    input: file,
    access: "read",
  },
  checkpoint_create: {
    title: "Save file checkpoint",
    description:
      "Save a limited private checkpoint of one authorized UTF-8 project file only when its current SHA-256 matches. Never capture recognized secrets.",
    input: {
      ...file,
      requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    },
    access: "write",
  },
  checkpoint_restore_plan: {
    title: "Compare checkpoint before recovery",
    description:
      "Compare a saved private checkpoint with the current authorized file hash; does not change project files or authorize rollback.",
    input: {
      ...scoped,
      requestKey: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    },
    access: "read",
  },
  create_project_directory: {
    title: "Create project folder",
    description:
      "Create one missing directory within an already-authorized writable project. Parent directory must exist; no arbitrary root, shell, symlink or dependency-folder traversal.",
    input: file,
    access: "write",
  },
  move_project_file: {
    title: "Move or rename project file",
    description:
      "Copy one bounded approved file to a previously nonexistent destination inside the same writable project, verify SHA-256 and remove the original. Existing destination is never overwritten.",
    input: {
      ...scoped,
      from: z.string().min(1).max(1024),
      to: z.string().min(1).max(1024),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    },
    access: "write",
  },
  copy_project_file: {
    title: "Copy project file",
    description:
      "Duplicate one bounded, hash-verified file within the same authorized writable project. Requires an unused destination and never removes or overwrites the source.",
    input: {
      ...scoped,
      from: z.string().min(1).max(1024),
      to: z.string().min(1).max(1024),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    },
    access: "write",
  },
  browser_agentic_observe: {
    title: "Owner-approved Browsentic read-only browser observation",
    description:
      "Optional SHA-pinned local Browsentic MCP observation of the already-open KMJ Main Platform browser tab. Checks exact HTTPS origin and path; returns only bounded element counts, not text, URLs with secrets, screenshots, cookies, credentials or interactive actions. Operator must enable and pair separately. Not visual QA.",
    input: {
      ...scoped,
      target: z.literal("kmj_owner_browser"),
      requestKey: z.string().min(1).max(128),
    },
    access: "execute",
  },
  browser_runtime_status: {
    title: "Local browser engine readiness",
    description:
      "Read-only, credential-free readiness of locally installed Chromium/Edge and pinned Moli engines for this authorized device. Shows deterministic text/visual QA selection and honest limitations, never executable paths, profiles, environment secrets, cookies or remote browser endpoints. No browser launches, downloads or cloud calls.",
    input: scoped,
    access: "read",
  },
  browser_fast_probe: {
    title: "Fast public browser probe (Moli with Chrome fallback)",
    description:
      "Queue one fixed-origin anonymous public-site semantic extraction via separately pinned Moli 1.1.18, falling back to the established Chrome nine-screenshot QA when Moli is absent, incompatible or fails. No caller URL, scripts, local/private-network navigation, credentials or worker-slot bypass. EXTRACTION_PASS is not full visual QA.",
    input: {
      ...scoped,
      target: z.literal("kmj_public"),
      requestKey: z.string().min(1).max(128),
    },
    access: "execute",
  },
  browser_fast_probe_receipt: {
    title: "Verified Moli/Chrome fast QA receipt",
    description:
      "Read only SHA-bound private extraction metadata or nine verified Chrome fallback screenshot hashes from a completed project-authorized fast browser job. No HTML, cookies, screenshot bytes, scripts or arbitrary paths.",
    input: { ...scoped, job: identifier },
    access: "read",
  },
  browser_qa_start: {
    title: "Live public browser QA",
    description:
      "Queue authenticated CodeBridge work for real anonymous Chrome/Edge public-site checks at fixed KMJ Main Platform URLs in desktop, tablet and mobile viewports. Captures nine private screenshots and HTTP/layout/JS evidence without touching the checkout, opening arbitrary URLs, or accessing owner sessions. Job status can be read while other project work continues; one free-plan agent still has one execution slot.",
    input: {
      ...scoped,
      target: z.literal("kmj_public"),
      requestKey: z.string().min(1).max(128),
    },
    access: "execute",
  },
  browser_qa_receipt: {
    title: "Browser QA evidence receipt",
    description:
      "Read a finished private browser QA receipt from a known job. Returns fixed public routes, viewport result codes and SHA-256 screenshot hashes, not image contents, browser cookies or credentials.",
    input: { ...scoped, job: identifier },
    access: "read",
  },
  list_project_jobs: {
    title: "Project sessions and jobs",
    description:
      "List bounded recent CodeBridge execution sessions for the authorized project without returning command output, arguments, or environment secrets.",
    input: {
      ...scoped,
      limit: z.number().int().min(1).max(100).default(20),
      state: z
        .enum([
          "all",
          "running",
          "queued",
          "succeeded",
          "failed",
          "cancelled",
          "timed_out",
          "interrupted",
        ])
        .default("all"),
      cursor: z
        .string()
        .regex(/^[a-zA-Z0-9-]{1,128}$/)
        .nullable()
        .default(null),
    },
    access: "read",
  },
  repo_intelligence: {
    title: "Repository intelligence",
    description:
      "Find bounded deterministic lexical symbol definitions and references inside the authorized project without uploading repository content or invoking an AI model.",
    input: {
      ...scoped,
      identifier: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/),
      operation: z.enum(["definitions", "references", "both"]).default("both"),
      maxFiles: z.number().int().min(1).max(200).default(80),
      maxResults: z.number().int().min(1).max(500).default(200),
    },
    access: "read",
  },
  repo_map: {
    title: "Repository map",
    description:
      "Build a bounded deterministic map of important project files and symbols without using an AI model.",
    input: {
      ...scoped,
      query: z.string().max(120).default(""),
      maxFiles: z.number().int().min(1).max(200).default(80),
      maxSymbolsPerFile: z.number().int().min(1).max(50).default(12),
    },
    access: "read",
  },
  context_pack: {
    title: "Context pack",
    description:
      "Build a deterministic delta-first coding context pack from Git changes, repository relevance and bounded file excerpts.",
    input: {
      ...scoped,
      query: z.string().max(120).default(""),
      budget: contextBudget.default("medium"),
    },
    access: "read",
  },
  git_status: {
    title: "Git status",
    description: "Read Git working-tree status for an authorized project.",
    input: scoped,
    access: "read",
  },
  git_diff: {
    title: "Git diff",
    description:
      "Read a bounded redacted working-tree diff for tracked files in an authorized project without invoking external diff helpers.",
    input: scoped,
    access: "read",
  },
  git_log: {
    title: "Git log",
    description:
      "Read up to 50 recent commits from the authorized repository with bounded output.",
    input: {
      ...scoped,
      limit: z.number().int().min(1).max(50).default(20),
    },
    access: "read",
  },
  git_show: {
    title: "Git show",
    description:
      "Read one bounded commit summary and patch by full or abbreviated hexadecimal commit id.",
    input: {
      ...scoped,
      commit: z.string().regex(/^[a-f0-9]{7,40}$/i),
    },
    access: "read",
  },
  git_index_probe: {
    title: "Inspect Git index/worktree EOL mismatch",
    description:
      "Read only Git's staged blob identity and a bounded authorized UTF-8 file's raw/LF-normalized blob SHA-1 hashes. Diagnose modified files after an atomic content restore without changing Git index, files, or running diff helpers.",
    input: file,
    access: "read",
  },
  git_reconcile_main: {
    title: "Reconcile merged main",
    description:
      "Fast-forward a writable authorized checkout to an exact origin/main commit only when every tracked working-tree byte already matches that commit and no untracked files exist.",
    input: {
      ...scoped,
      expectedRemoteHead: z.string().regex(/^[a-f0-9]{40}$/i),
    },
    access: "execute",
  },
  hyperindex_status: {
    title: "Inspect project HyperIndex availability",
    description:
      "Inspect local index presence without creating files. Presence does not attest index integrity or freshness. Windows persistence remains unavailable until ACL validation is implemented.",
    input: { ...scoped },
    access: "read",
  },
  hyperindex_build: {
    title: "Build bounded project HyperIndex",
    description:
      "Explicitly create and reconcile a private on-device SQLite index of policy-approved redacted project text. Bounded to 2000 entries and 8 MiB scanned text; no source upload or external service.",
    input: { ...scoped },
    access: "execute",
  },
  hyperindex_search: {
    title: "Search project HyperIndex with safe fallback",
    description:
      "Search literal text with policy revalidation and explicit coverage. Reconcile an existing index; if absent, corrupt or unavailable use bounded live lexical search. Does not enable an index automatically. No guaranteed speedup.",
    input: {
      ...scoped,
      query: z.string().min(1).max(200),
      maxResults: z.number().int().min(1).max(100).optional(),
    },
    access: "read",
  },
  search_code: {
    title: "Search code",
    description:
      'Search literal text in allowed project files with bounded results. Optional pathPrefix (an existing project directory), extensions (for example [".js"]), caseSensitive and maxResults (1-100) narrow the search; the same path, symlink and secret-file rules apply.',
    input: {
      ...scoped,
      query: z.string().min(1).max(200),
      pathPrefix: z.string().min(1).max(1024).optional(),
      extensions: z
        .array(z.string().regex(/^\.[A-Za-z0-9]{1,10}$/))
        .min(1)
        .max(10)
        .optional(),
      caseSensitive: z.boolean().optional(),
      maxResults: z.number().int().min(1).max(100).optional(),
    },
    access: "read",
  },
  read_file: {
    title: "Read file",
    description:
      "Read a bounded UTF-8 project file and its SHA-256 precondition.",
    input: file,
    access: "read",
  },
  read_file_tail: {
    title: "Read recent project file lines",
    description:
      "Return only the last 1–200 lines of one approved UTF-8 project file, bounded to 8192 characters and redacted; never run a shell, follow links or expose unrelated host files.",
    input: {
      ...file,
      maxLines: z.number().int().min(1).max(200).default(40),
    },
    access: "read",
  },
  read_file_range: {
    title: "Read file range",
    description:
      "Read a bounded line range from an authorized UTF-8 file while returning the full-file SHA-256 precondition.",
    input: {
      ...file,
      startLine: z.number().int().min(1).default(1),
      maxLines: z.number().int().min(1).max(500).default(200),
    },
    access: "read",
  },
  read_files_batch: {
    title: "Read files batch",
    description:
      "Read up to 20 authorized UTF-8 files or line ranges in one round trip with per-file hashes.",
    input: {
      ...scoped,
      files: z
        .array(
          z.object({
            path: z.string().min(1).max(1024),
            startLine: z.number().int().min(1).optional(),
            maxLines: z.number().int().min(1).max(500).optional(),
          }),
        )
        .min(1)
        .max(20),
    },
    access: "read",
  },
  preview_file: {
    title: "KMJ • Preview guarded file change",
    description:
      "Read-only validation of a proposed change. No write or ChatGPT write approval is requested for preview.",
    input: patch,
    access: "read",
  },
  write_file: {
    title: "KMJ • Apply guarded single-file change",
    description:
      "Write ONE authorized file with SHA-256 precondition, or create with null. For multiple files prefer write_files_atomic to minimize separate host write approvals; host decides prompts.",
    input: patch,
    access: "write",
  },
  edit_file: {
    title: "KMJ • Apply exact fragment edit",
    description:
      "Write ONE exact, unique fragment inside an authorized project with SHA-256 verification. For a multi-file change prefer a single write_files_atomic call.",
    input: {
      ...file,
      oldText: z.string().min(1).max(65536),
      newText: z.string().max(65536),
      leaseToken: z.string().uuid().optional(),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    },
    access: "write",
  },
  write_files_atomic: {
    title: "KMJ • Apply guarded multi-file batch",
    description:
      "Preferred multi-file write: apply 1–50 authorized SHA-256-guarded file changes in ONE atomic transaction and ONE tool invocation. Preview and review first. Never bypass ChatGPT host approval; may reduce repetitive write prompts.",
    input: {
      ...scoped,
      leaseToken: z.string().uuid().optional(),
      changes: z
        .array(
          z.object({
            path: z.string().min(1).max(1024),
            content: z.string().max(262144),
            expectedHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable(),
          }),
        )
        .min(1)
        .max(50),
    },
    access: "write",
  },
  skill_recommendations: {
    title: "Recommend engineering skill packs",
    description:
      "Deterministically select bounded vendor-neutral engineering workflows from the task objective, changed paths and an optional failure summary. No model call or repository upload is used.",
    input: {
      ...scoped,
      objective: z.string().min(1).max(4096),
      changedFiles: z.array(z.string().min(1).max(1024)).max(50).default([]),
      failureSummary: z.string().max(4096).default(""),
      observations: z
        .array(
          z
            .object({
              eventId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/),
              project: identifier,
              sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,63}$/),
              skill: z.enum([
                "security-hardening",
                "debugging",
                "tdd",
                "release-readiness",
              ]),
              kind: z.enum([
                "ci_failure",
                "user_correction",
                "repeated_work",
                "skill_gap",
              ]),
              causeCode: z.string().regex(/^[A-Z][A-Z0-9_]{3,47}$/),
              evidence: z.enum(["REPRODUCED", "USER_CONFIRMED", "UNVERIFIED"]),
            })
            .strict(),
        )
        .max(32)
        .optional(),
    },
    access: "read",
  },
  model_route_plan: {
    title: "Intelligent zero-cost model route plan",
    description:
      "Read-only routing plan for configured CodeBridge AI-chat inference. Cloud models need caller-approved access, fresh healthy provider metadata, confirmed zero price, exact OpenRouter :free model ID and context/quota fit; local is the backup. No model invocation, provider keys or host-chat model switching.",
    input: {
      ...scoped,
      models: z
        .array(
          z.object({
            id: z.string().min(1).max(96),
            provider: z.string().min(1).max(96),
            kind: z.enum(["local", "cloud"]),
            free: z.boolean(),
            privateCodeAllowed: z.boolean(),
            enabled: z.boolean().optional(),
            health: z.enum(["ok", "error", "unknown"]).optional(),
            modelsDiscoveredAtMs: z.number().int().min(0).optional(),
            available: z.boolean().optional(),
            contextWindow: z.number().int().positive().max(1_000_000),
            capabilities: z.array(z.string().min(1).max(32)).max(16),
            qualityScore: z.number().min(0).max(100).optional(),
            reliabilityPct: z.number().min(0).max(100).optional(),
            p95LatencyMs: z.number().min(0).max(120000).optional(),
            freeTierVerified: z.boolean().optional(),
            costPerMillionTokensUsd: z.number().min(0).optional(),
          }),
        )
        .min(1)
        .max(64),
      task: z.object({
        capability: z
          .string()
          .regex(/^[a-z][a-z0-9-]{0,31}$/)
          .default("coding"),
        inputTokens: z.number().int().min(0).max(1_000_000),
        maxOutputTokens: z.number().int().min(1).max(1_000_000),
        strategy: z
          .enum([
            "local-first",
            "approved-free-cloud-first",
            "fastest",
            "highest-quality",
          ])
          .default("approved-free-cloud-first"),
        cloudApproved: z.boolean().default(false),
        privateCode: z.boolean().default(true),
      }),
      quotaState: z
        .record(
          z.object({
            remainingRequests: z.number().int().min(0).nullable().optional(),
            remainingTokens: z.number().int().min(0).nullable().optional(),
            resetRequestsAt: z.number().int().min(0).nullable().optional(),
            resetTokensAt: z.number().int().min(0).nullable().optional(),
            cooldownUntil: z.number().int().min(0).optional(),
          }),
        )
        .default({}),
    },
    access: "read",
  },
  mission_compile: {
    title: "Compile mission",
    description:
      "Persist a structured engineering mission and materialize its dependency-aware task DAG into resumable autopilot work.",
    input: {
      ...scoped,
      key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      objective: z.string().min(1).max(8192),
      acceptanceCriteria: z.array(z.string().min(1).max(1024)).max(30),
      requirements: z.object({
        security: z.array(z.string().max(512)).max(20).default([]),
        reliability: z.array(z.string().max(512)).max(20).default([]),
        performance: z.array(z.string().max(512)).max(20).default([]),
        documentation: z.array(z.string().max(512)).max(20).default([]),
      }),
      tasks: z
        .array(
          z.object({
            key: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
            objective: z.string().min(1).max(8192),
            priority: z.number().int().min(-100).max(100).default(0),
            dependsOn: z
              .array(z.string().regex(/^[A-Za-z0-9._-]{1,64}$/))
              .max(20)
              .default([]),
          }),
        )
        .min(1)
        .max(50),
      ownerGates: z.array(z.string().min(1).max(1024)).max(20).default([]),
      definitionOfDone: z.string().min(1).max(4096),
      aiBudget: z
        .enum(["economical", "balanced", "maximum_assurance"])
        .default("balanced"),
    },
    access: "write",
  },
  mission_status: {
    title: "Mission status",
    description:
      "Read one persisted mission, task DAG state, acceptance criteria and mapped evidence.",
    input: { ...scoped, mission: identifier },
    access: "read",
  },
  mission_evidence: {
    title: "Record mission evidence",
    description:
      "Attach bounded redacted evidence to one acceptance criterion in a persisted mission.",
    input: {
      ...scoped,
      mission: identifier,
      criterionIndex: z.number().int().min(0).max(29),
      evidence: z.string().min(1).max(4096),
    },
    access: "write",
  },
  autopilot_status: {
    title: "Autopilot status",
    description:
      "Read persistent autonomous-work state, including the next dependency-ready task.",
    input: {
      ...scoped,
      limit: z.number().int().min(1).max(100).default(50),
    },
    access: "read",
  },
  autopilot_continuation_status: {
    title: "Read automatic task-continuation handoff status",
    description:
      "Verify the event-driven local coordination bridge and durable project handoffs after task completion or blockers. Existing opt-in workers continue approved work; ChatGPT itself is not automatically awakened or executed.",
    input: scoped,
    access: "read",
  },
  autopilot_repair_candidate: {
    title: "Review SHA-verified isolated repair candidate",
    description:
      "Read only: verify a previously completed deterministic repair or local-first coding checkpoint, exact detached worktree, safe allowlisted diff, SHA-256 and optional redacted preview. Never applies, commits, publishes or deploys a patch.",
    input: {
      ...scoped,
      task: identifier,
      includePatch: z.boolean().default(false),
    },
    access: "read",
  },
  autopilot_worker_runtime_status: {
    title: "Read real agent worker startup status",
    description:
      "Report configured versus actually started CodeBridge gate, isolated repair, GitHub CI watcher, offline draft and local-first coding worker loops for this enrolled project. No secrets, tokens, commands or false deployment claims.",
    input: scoped,
    access: "read",
  },
  autopilot_enqueue: {
    title: "Enqueue autopilot task",
    description:
      "Persist a bounded project-scoped autonomous task with dependency and idempotency metadata.",
    input: {
      ...scoped,
      key: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
      objective: z.string().min(1).max(8192),
      priority: z.number().int().min(-100).max(100).default(0),
      dependsOn: z.array(identifier).max(20).default([]),
    },
    access: "write",
  },
  autopilot_claim: {
    title: "Claim next autopilot task",
    description:
      "Claim the highest-priority dependency-ready task as a time-bounded lease. Returns leaseToken: pass it to checkpoint/wait/complete (checkpoints renew the lease). Expired leases return to the queue so a disconnected chat cannot hold work forever.",
    input: {
      ...scoped,
      holder: z
        .string()
        .regex(/^[A-Za-z0-9._:@\/# -]{1,96}$/)
        .optional(),
    },
    access: "write",
  },
  autopilot_local_draft: {
    title: "Draft Autopilot task with local AI and checkpoint",
    description:
      "Generate one bounded, review-only proposal for an already claimed Autopilot task using an installed loopback local model. Persist a safe checkpoint for retries; no shell, file writes, external models, paid inference or automatic deployment.",
    input: {
      ...scoped,
      task: z.string().uuid(),
      model: z.string().regex(/^[A-Za-z0-9._:/-]{1,96}$/),
      maxTokens: z.number().int().min(32).max(512).default(256),
      timeoutSeconds: z.number().int().min(5).max(90).default(45),
      localProcessingApproved: z.literal(true),
      leaseToken: z.string().uuid().optional(),
    },
    access: "execute",
  },
  autopilot_checkpoint: {
    title: "Checkpoint autopilot task",
    description:
      "Persist bounded resumable progress for a running autonomous task.",
    input: {
      ...scoped,
      task: identifier,
      summary: z.string().max(8192),
      next: z.string().max(8192),
      leaseToken: z.string().uuid().optional(),
    },
    access: "write",
  },
  autopilot_wait: {
    title: "Pause autopilot task",
    description:
      "Move one running task to waiting while allowing independent queued work to continue.",
    input: {
      ...scoped,
      task: identifier,
      reason: z.string().min(1).max(4096),
      leaseToken: z.string().uuid().optional(),
      // Opt-in typed handoff; no arbitrary text becomes an execution command.
      blockerCode: z.enum(BLOCKER_CODES).optional(),
    },
    access: "write",
  },
  autopilot_resume: {
    title: "Resume autopilot task",
    description:
      "Return a waiting autonomous task to the dependency-ready queue.",
    input: { ...scoped, task: identifier },
    access: "write",
  },
  autopilot_complete: {
    title: "Complete autopilot task",
    description:
      "Record a terminal autonomous-task result without executing arbitrary commands.",
    input: {
      ...scoped,
      task: identifier,
      state: z.enum(["succeeded", "failed", "cancelled"]),
      result: z.string().max(8192),
      leaseToken: z.string().uuid().optional(),
    },
    access: "write",
  },
  supervisor_status: {
    title: "Supervisor service status",
    description:
      "Read bounded status for an allowlisted local CodeBridge service.",
    input: { ...scoped, service: supervisorService },
    access: "read",
  },
  supervisor_logs: {
    title: "Supervisor service logs",
    description:
      "Read up to 200 redacted journal lines for an allowlisted local CodeBridge service.",
    input: {
      ...scoped,
      service: supervisorService,
      lines: z.number().int().min(1).max(200).default(80),
    },
    access: "read",
  },
  supervisor_config_validate: {
    title: "Validate CodeBridge config",
    description:
      "Validate one fixed CodeBridge configuration file without returning its contents.",
    input: { ...scoped, service: supervisorService },
    access: "read",
  },
  supervisor_disk_space: {
    title: "Supervisor disk space",
    description:
      "Read bounded disk-space information for the fixed CodeBridge state filesystem.",
    input: scoped,
    access: "read",
  },
  supervisor_project_status: {
    title: "Managed project status",
    description:
      "Read bounded local checkout state for the already-authorized project. The supervisor derives the managed filesystem root; no path or repository can be supplied.",
    input: scoped,
    access: "read",
  },
  supervisor_device_status: {
    title: "Device resource status",
    description:
      "Read a bounded device resource snapshot from the local CodeBridge supervisor, including CPU count, memory, load, uptime, platform, architecture, hostname, and Node runtime version.",
    input: scoped,
    access: "read",
  },
  supervisor_main_platform_production_status: {
    title: "Main Platform production release status",
    description:
      "Read fixed KMJ-elite production release pointer, pre-approved immutable SHA, Nginx/PHP health and guarded operator-installed deployment unit availability. No command, path, environment, secret or release target can be supplied.",
    input: scoped,
    access: "read",
  },
  supervisor_main_platform_maintenance_status: {
    title: "Main Platform maintenance readiness",
    description:
      "Read fixed KMJ-elite backup and health one-shot/timer systemd states through the privileged Supervisor. No caller-selected units, shell, secrets, backup transfer, service restarts or production release approval.",
    input: scoped,
    access: "read",
  },
  supervisor_main_platform_production_activate: {
    title: "Activate operator-approved Main Platform production release",
    description:
      "Trigger only an operator-installed guarded Main Platform release systemd unit after matching a protected approval manifest, exact expected current release and approved SHA. Requires execute permission and explicit confirmation; does not accept commands, paths, branch names or arbitrary SHA targets. Accepted is not deployed: verify real post-cutover health separately.",
    input: {
      ...scoped,
      approvedSha: z.string().regex(/^[a-f0-9]{40}$/),
      expectedCurrentRelease: z.string().regex(/^[a-z0-9][a-z0-9_-]{3,100}$/),
      confirmation: z.literal("ACTIVATE_APPROVED_PRODUCTION_RELEASE"),
    },
    access: "execute",
  },
  supervisor_main_platform_refresh_status: {
    title: "Main Platform refresh status",
    description:
      "Read the fixed Main Platform refresh service state. No service name, command, path or credential can be supplied.",
    input: scoped,
    access: "read",
  },
  supervisor_main_platform_refresh: {
    title: "Refresh Main Platform agent",
    description:
      "Start the fixed existing-enrollment Main Platform agent refresh service. It cannot enroll a new device and accepts no command, path, service name or credential.",
    input: scoped,
    access: "execute",
  },
  supervisor_private_pr322_ci_status: {
    title: "Private PR322 CI status",
    description:
      "Read a bounded SHA-bound local VPS CI result for the fixed Main Platform Owner Plan PR and its guarded systemd service. Local Linux is never presented as hosted GitHub Actions or Windows CI.",
    input: scoped,
    access: "read",
  },
  supervisor_private_pr322_ci_start: {
    title: "Run private PR322 CI",
    description:
      "Start only the fixed isolated Main Platform PR322 verifier on the existing VPS, with no caller-selected SHA, repository, shell, path or environment. Requires a preinstalled guarded unit.",
    input: scoped,
    access: "execute",
  },
  supervisor_private_pr337_ci_status: {
    title: "Private PR337 CI status",
    description:
      "Read a bounded SHA-bound local VPS CI result for the fixed Main Platform Public Website PR and its guarded systemd service. Local Linux is never presented as hosted GitHub Actions or Windows CI.",
    input: scoped,
    access: "read",
  },
  supervisor_private_pr337_ci_start: {
    title: "Run private PR337 CI",
    description:
      "Start only the fixed isolated Main Platform PR337 verifier on the existing VPS, with no caller-selected SHA, repository, shell, path or environment. Requires a preinstalled guarded unit.",
    input: scoped,
    access: "execute",
  },
  supervisor_private_pr419_ci_status: {
    title: "Private PR419 CI status",
    description:
      "Read a bounded SHA-bound local VPS CI result for the fixed Main Platform Payment Gateway PR and its guarded systemd service. Local Linux is never presented as hosted GitHub Actions or Windows CI.",
    input: scoped,
    access: "read",
  },
  supervisor_private_pr419_ci_start: {
    title: "Run private PR419 CI",
    description:
      "Start only the fixed isolated Main Platform PR419 verifier on the existing VPS, with no caller-selected SHA, repository, shell, path or environment. Requires a preinstalled guarded unit.",
    input: scoped,
    access: "execute",
  },
  supervisor_update_status: {
    title: "Auto-update status",
    description:
      "Read bounded status for the fixed CodeBridge development auto-update timer/service and existing Main Platform agent refresh service. No arbitrary service names or paths.",
    input: scoped,
    access: "read",
  },
  supervisor_update_check: {
    title: "Check signed update",
    description:
      "Start the fixed signed-update check service. No URL, repository, branch, command or path can be supplied.",
    input: scoped,
    access: "execute",
  },
  supervisor_release_history: {
    title: "Release history",
    description:
      "Read bounded secret-free release activation history from the fixed updater state.",
    input: scoped,
    access: "read",
  },
  supervisor_update_rollback: {
    title: "Rollback CodeBridge release",
    description:
      "Request rollback only to the updater-recorded previous healthy release. No version, path or command can be supplied.",
    input: scoped,
    access: "execute",
  },
  supervisor_update_now: {
    title: "Run guarded auto-update",
    description:
      "Start the hardcoded guarded CodeBridge development auto-update service. No repository, branch, command or path can be supplied by the caller.",
    input: scoped,
    access: "execute",
  },
  supervisor_restart: {
    title: "Restart CodeBridge service",
    description:
      "Schedule restart of one allowlisted local CodeBridge service. No arbitrary service names are accepted.",
    input: { ...scoped, service: supervisorService },
    access: "execute",
  },
  list_project_commands: {
    title: "List project commands",
    description:
      "List administrator-approved structured command profiles and named variants without exposing raw executables or arguments.",
    input: scoped,
    access: "read",
  },
  run_project_command: {
    title: "Run project command",
    description:
      "Run one exact administrator-approved command profile variant through the bounded CodeBridge job runner. No shell, cwd, environment, argv or timeout override is accepted. The main_platform_ui_ci, project-scoped calibration_v4_qa, and explicitly administrator-approved SHA-pinned Windows PowerShell scripts automatically use detached private worktrees at exact HEAD when laneId/expectedHead are omitted. PowerShell script paths and SHA-256 are fixed in the agent profile; chat clients cannot choose or upload commands/scripts/argv.",
    input: {
      ...scoped,
      command: identifier,
      variant: identifier,
      requestKey: z.string().min(1).max(128),
      laneId: laneIdentifier.optional(),
      expectedHead: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .optional(),
    },
    access: "execute",
  },
  ide_run_project_task: {
    title: "IDE: run approved project task with compact receipt",
    description:
      "Run an existing administrator-approved command profile in an authorized project, with exact-head isolated lane rules inherited from run_project_command. Wait briefly and return a small redacted QA receipt instead of pasted terminal logs. Never accepts shell, free-form argv, cwd, environment, script body, repo URL or deployment override. Requires connected device and read+execute grants.",
    input: {
      ...scoped,
      command: identifier,
      variant: identifier,
      requestKey: z.string().min(1).max(128),
      laneId: laneIdentifier.optional(),
      expectedHead: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .optional(),
      waitMs: z.number().int().min(0).max(10000).default(2500),
    },
    access: "execute",
  },
  ide_job_receipt: {
    title: "IDE: compact project job result",
    description:
      "Return compact verified local runner state plus bounded redacted project-reported QA markers for one authorized job, without sending the full terminal log. Does not convert printed PASS text into physical or release approval.",
    input: {
      ...scoped,
      job: identifier,
      waitMs: z.number().int().min(0).max(10000).default(0),
    },
    access: "read",
  },
  run_quality_gate: {
    title: "Run quality gate",
    description:
      "Start an administrator-configured command. It can execute project code and change files. Use a stable requestKey for retries. Optional laneId runs the gate inside an already-prepared isolated worktree (worktree_lane_prepare) instead of the shared project checkout, so concurrent uncommitted work elsewhere is never touched.",
    input: {
      ...scoped,
      gate: identifier,
      requestKey: z.string().min(1).max(128),
      laneId: laneIdentifier.optional(),
    },
    access: "execute",
  },
  get_job_status: {
    title: "Get job status",
    description:
      "Read a job result and bounded redacted logs within the authorized project. Optional waitMs (0-10000) waits for a queued or running job to finish before answering, so one call replaces many polls; optional tailChars (0-8192) returns only the end of the log.",
    input: {
      ...scoped,
      job: identifier,
      waitMs: z.number().int().min(0).max(10000).optional(),
      tailChars: z.number().int().min(0).max(8192).optional(),
    },
    access: "read",
  },
  cancel_job: {
    title: "Cancel job",
    description:
      "Cancel an authorized project job and terminate its subprocesses.",
    input: { ...scoped, job: identifier },
    access: "write",
  },
  connection_doctor: {
    title: "Connection doctor",
    description:
      "Read connection health and available project capabilities and diagnose missing hosted tools, inactive local workers, CI launch failures and dirty checkouts; never changes settings or executes work.",
    input: {
      ...scoped,
      // Optional observations from the client are advisory, not host-verified.
      clientVisibleTools: z
        .array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/))
        .max(120)
        .optional(),
      ciObservation: z
        .enum([
          "unknown",
          "job-no-steps",
          "executed-test-fail",
          "checks-pending",
          "passed",
        ])
        .optional(),
      checkoutState: z.enum(["unknown", "dirty", "clean"]).optional(),
    },
    access: "read",
  },
};
const MAX_JOB_WAITERS = 16;

export function createDispatcher(
  config,
  runner,
  licenseProvider,
  autopilot = null,
  supervisor = null,
  audit = null,
  localModelFactory = createLocalModelClient,
  workerRuntimeSource = null,
  toolGuardHost = null,
) {
  const projects = new Map(
    config.projects.map((p) => [
      p.id,
      { ...p, files: new ProjectFiles(p.root) },
    ]),
  );
  let localModel;
  const offlineModel = () => (localModel ??= localModelFactory());
  // In-memory per-device/project observation only, never a ChatGPT/Claude
  // conversation identifier or inference on the host client's model.
  const lastModelUsage = new Map();
  const rememberModel = (project, usage) => {
    lastModelUsage.set(project, {
      ...usage,
      observedAt: new Date().toISOString(),
    });
  };
  let laneRegistry;
  let coordinationRegistry;
  let continuityRegistry;
  const laneStateDir =
    typeof config.stateDir === "string" && config.stateDir.length > 0
      ? config.stateDir
      : typeof runner.dir === "string" && runner.dir.length > 0
        ? path.dirname(runner.dir)
        : null;
  const lanes = () => {
    if (!laneStateDir) fail("CHAT_LANE_STATE_UNAVAILABLE");
    return (laneRegistry ??= new ChatLaneRegistry(laneStateDir));
  };
  const coordination = () => {
    if (!laneStateDir) fail("COORDINATION_STATE_UNAVAILABLE");
    return (coordinationRegistry ??= new AgentCoordination(laneStateDir));
  };
  const continuity = () => {
    if (!laneStateDir) fail("CHAT_CONTINUITY_STATE_UNAVAILABLE");
    return (continuityRegistry ??= new ChatContinuity(laneStateDir));
  };
  let worktrees;
  const worktreeLanes = () => {
    if (!laneStateDir) fail("WORKTREE_STATE_UNAVAILABLE");
    return (worktrees ??= new WorktreeLanes(laneStateDir));
  };
  let checkpointStore;
  const checkpoints = () =>
    (checkpointStore ??= new FileCheckpoints(config.stateDir));
  let jobWaiters = 0;
  const dispatchCore = async function dispatchCore(name, input, permissions) {
    const definition = definitions[name];
    if (!definition || name === "list_devices") fail("UNKNOWN_TOOL");
    const a = z.object(definition.input).strict().parse(input);
    if (a.device !== config.id || !permissions.includes(definition.access))
      fail("ACCESS_DENIED");
    const p = projects.get(a.project);
    if (!p) fail("PROJECT_NOT_FOUND");
    // Safe status and cancellation remain usable after paid lease expiry.
    if (
      ![
        "get_job_status",
        "cancel_job",
        "autopilot_status",
        "audit_status",
        "audit_tail",
      ].includes(name)
    ) {
      const entitlement = licenseProvider();
      if (!entitlement.features.includes(definition.access))
        fail("FEATURE_UNAVAILABLE");
      runner.maxConcurrent = entitlement.limits.concurrent_jobs;
    }
    // The trusted Harness-style extension seam runs AFTER the existing
    // device, project, permission and entitlement checks. Guard plugins see
    // immutable coarse facts only and can veto, never override authorization.
    if (toolGuardHost)
      await toolGuardHost.preflight({
        device: config.id,
        project: p.id,
        tool: name,
        access: definition.access,
        writable: p.writable,
      });
    if (name === "inspect_project" || name === "connection_doctor") {
      // Only a trusted read-only RPC can verify reachability.
      // Windows HMAC named pipes are independent of the Linux socket probe.
      const doctorSocketObservation =
        name !== "connection_doctor"
          ? null
          : process.platform === "win32"
            ? {
                state:
                  config.supervisorPipe && config.supervisorTokenFile
                    ? "WINDOWS_PIPE_CONFIGURED_UNVERIFIED"
                    : "WINDOWS_PIPE_NOT_CONFIGURED",
                observedPlatform: "win32",
                socketExists: null,
                authenticated: false,
                noServiceMutation: true,
              }
            : observeSupervisorSocket({
                configured: Boolean(config.supervisorSocket),
              });
      let doctorSupervisorVerified = false;
      if (
        [
          "SOCKET_PRESENT_UNVERIFIED",
          "WINDOWS_PIPE_CONFIGURED_UNVERIFIED",
        ].includes(doctorSocketObservation?.state) &&
        typeof supervisor?.request === "function"
      ) {
        try {
          const status = await supervisor.request({
            op: "status",
            service: "agent",
          });
          doctorSupervisorVerified =
            doctorSocketObservation?.state ===
            "WINDOWS_PIPE_CONFIGURED_UNVERIFIED"
              ? isTrustedWindowsSupervisorStatus(status)
              : status?.activeState === "active" &&
                status?.subState === "running" &&
                Number.isSafeInteger(status?.mainPid) &&
                status.mainPid > 0;
        } catch {
          // No warning payload, secrets, or false-positive health claims.
          doctorSupervisorVerified = false;
        }
      }
      return {
        device: config.id,
        project: p.id,
        writable: p.writable,
        gates: Object.keys(p.gates),
        commands: Object.entries(p.commands ?? {}).map(([id, profile]) => ({
          id,
          category: profile.category,
          description: profile.description,
          risk: commandRisk(profile.category),
          approvalRequired: approvalRequired(commandRisk(profile.category)),
          variants: Object.keys(profile.variants),
        })),
        connection: "connected",
        version: VERSION,
        // Commit of the code this agent process runs (null when unknown). A
        // "git-branch" source is a checkout and may carry uncommitted edits.
        runtimeRevision: runtimeRevision(),
        ...(name === "connection_doctor"
          ? {
              modelUsageStatus: {
                scope: "device_project_current_agent_process",
                lastVerifiedInvocation: lastModelUsage.get(p.id) ?? null,
                originalChatHostModel: "not_observable_by_codebridge",
                note: "Only successful CodeBridge model tool calls are observed. A configured provider or a tool call without inference is not model usage. This is per-project, not per-chat.",
              },
              blockerRecovery: inspectBlockers({
                clientVisibleTools: a.clientVisibleTools ?? null,
                // Only a successful trusted bounded Supervisor status RPC
                // upgrades the filesystem observation into live health.
                supervisorConfigured: Boolean(
                  config.supervisorSocket ||
                    (config.supervisorPipe && config.supervisorTokenFile),
                ),
                supervisorObservation: doctorSocketObservation,
                supervisorHealthVerified: doctorSupervisorVerified,
                workerConfiguration: {
                  gate: p.autopilotGateWorker?.enabled === true,
                  repair: p.autopilotRepairWorker?.enabled === true,
                  githubCiWatch: p.autopilotCiWatch?.enabled === true,
                  localDraft: p.autopilotLocalWorker?.enabled === true,
                  coding:
                    p.autopilotCodingWorker?.enabled === true &&
                    p.autopilotCodingWorker?.localProcessingApproved === true,
                },
                workerStarted:
                  typeof workerRuntimeSource === "function"
                    ? (() => {
                        const observed = workerRuntimeSource();
                        if (!observed || observed.agentRunning !== true)
                          return null;
                        return Object.fromEntries(
                          [
                            "gate",
                            "repair",
                            "githubCiWatch",
                            "localDraft",
                            "coding",
                          ].map((kind) => [
                            kind,
                            Array.isArray(observed[kind])
                              ? observed[kind].includes(p.id)
                              : false,
                          ]),
                        );
                      })()
                    : null,
                ciObservation: a.ciObservation ?? "unknown",
                checkoutState: a.checkoutState ?? "unknown",
              }),
            }
          : {}),
      };
    }
    if (name === "worktree_lane_status")
      return {
        device: config.id,
        project: p.id,
        ...worktreeLanes().status(p.id, p.files.root),
      };
    if (name === "worktree_lane_prepare") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      const capacity = runner.capacity(p.files.root);
      if (capacity.blocked || capacity.effectiveMaxConcurrent < 1)
        fail("WORKTREE_CAPACITY_BLOCKED");
      return {
        device: config.id,
        project: p.id,
        ...worktreeLanes().prepare(
          p.id,
          p.files.root,
          a.laneId,
          a.expectedHead,
        ),
      };
    }
    if (name === "worktree_lane_prepare_cached_main") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      const capacity = runner.capacity(p.files.root);
      if (capacity.blocked || capacity.effectiveMaxConcurrent < 1)
        fail("WORKTREE_CAPACITY_BLOCKED");
      return {
        device: config.id,
        project: p.id,
        ...worktreeLanes().prepareCachedRemoteMain(
          p.id,
          p.files.root,
          a.laneId,
          a.expectedRemoteHead,
        ),
      };
    }
    if (name === "worktree_lane_cleanup") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      if (a.laneId !== a.confirmLaneId) fail("WORKTREE_CONFIRMATION_MISMATCH");
      return {
        device: config.id,
        project: p.id,
        ...worktreeLanes().cleanup(
          p.id,
          p.files.root,
          a.laneId,
          a.expectedHead,
        ),
      };
    }
    if (name === "local_model_status")
      return {
        device: config.id,
        project: p.id,
        ...(await offlineModel().status()),
      };
    if (name === "local_model_generate") {
      const response = await offlineModel().generate({
        model: a.model,
        prompt: a.prompt,
        maxTokens: a.maxTokens,
        timeoutSeconds: a.timeoutSeconds,
      });
      const usage = localModelReceipt(a.model, "local_model_generate");
      rememberModel(p.id, usage);
      return {
        device: config.id,
        project: p.id,
        ...response,
        modelUsage: usage,
      };
    }
    if (name === "coordination_list")
      return {
        device: config.id,
        ...coordination().list(p.id, { limit: a.limit, after: a.after }),
      };
    if (name === "coordination_post")
      return {
        device: config.id,
        ...coordination().post(p.id, a),
      };
    if (name === "compact_session_save") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      const {
        requestKey,
        expectedRevision,
        objective,
        summary,
        decisions,
        constraints,
        evidence,
        blockers,
        nextSteps,
      } = a;
      const saved = new CompactSessionStore(config.stateDir).save(
        p.id,
        a.lane,
        {
          requestKey,
          expectedRevision,
          objective,
          summary,
          decisions,
          constraints,
          evidence,
          blockers,
          nextSteps,
        },
      );
      return {
        device: config.id,
        ...saved,
        checkpointSaved: true,
        contentTrusted: false,
        hostContextWindowExtended: false,
        followUpTool: "compact_session_resume",
      };
    }
    if (name === "compact_session_resume")
      return {
        device: config.id,
        ...new CompactSessionStore(config.stateDir).resume(
          p.id,
          a.lane,
          a.ifNoneMatch,
        ),
      };
    if (name === "chat_continuity_read")
      return { device: config.id, ...continuity().status(p.id, a.lane) };
    if (name === "chat_continuity_save")
      return {
        device: config.id,
        ...continuity().save(p.id, a.lane, {
          requestKey: a.requestKey,
          expectedRevision: a.expectedRevision,
          summary: a.summary,
          next: a.next,
          blockers: a.blockers,
        }),
      };
    if (name === "chat_lane_status")
      return { device: config.id, project: p.id, ...lanes().status(p.id) };
    if (name === "chat_lane_reserve") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      return {
        device: config.id,
        project: p.id,
        ...lanes().reserve(p.id, a.requestKey, a.paths, a.ttlSeconds),
      };
    }
    if (name === "chat_lane_release") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      return {
        device: config.id,
        project: p.id,
        ...lanes().release(p.id, a.leaseToken),
      };
    }
    if (name === "project_environment")
      return {
        device: config.id,
        project: p.id,
        ...detectProjectEnvironment(p.files),
      };
    if (name === "free_first_audit") {
      const wanted = [];
      try {
        for (const entry of p.files.list(".github/workflows").entries)
          if (entry.type === "file" && /\.ya?ml$/i.test(entry.name))
            wanted.push(`.github/workflows/${entry.name}`);
      } catch {
        // No workflow directory is a valid state.
      }
      wanted.sort();
      const considered = wanted.slice(0, 40);
      wanted.push(".circleci/config.yml", ".circleci/config.yaml");
      const files = [];
      const skippedFiles = [];
      for (const rel of [
        ...considered,
        ".circleci/config.yml",
        ".circleci/config.yaml",
      ]) {
        try {
          files.push({ path: rel, content: p.files.read(rel).content });
        } catch {
          if (rel.startsWith(".github/")) skippedFiles.push(rel);
        }
      }
      const audit = auditFreeFirst(files);
      return {
        device: config.id,
        project: p.id,
        ...audit,
        findings: audit.findings.map((f) => ({
          ...f,
          evidence: redact(f.evidence),
        })),
        skippedFiles,
        workflowFilesTruncated:
          wanted.filter((w) => w.startsWith(".github/")).length > 40,
      };
    }
    if (name === "policy_catalog")
      return {
        device: config.id,
        project: p.id,
        riskClasses: [...RISK_CLASSES],
        approvalRequiredFor: RISK_CLASSES.filter(approvalRequired),
        tools: Object.entries(definitions)
          .filter(([tool]) => tool !== "list_devices")
          .map(([tool, toolDefinition]) => {
            const risk = toolRisk(tool, toolDefinition);
            return {
              tool,
              access: toolDefinition.access,
              risk,
              approvalRequired: approvalRequired(risk),
            };
          })
          .sort((a, b) => a.tool.localeCompare(b.tool)),
        commands: Object.entries(p.commands ?? {})
          .map(([id, profile]) => {
            const risk = commandRisk(profile.category);
            return {
              id,
              category: profile.category,
              risk,
              approvalRequired: approvalRequired(risk),
              variants: Object.keys(profile.variants),
            };
          })
          .sort((a, b) => a.id.localeCompare(b.id)),
      };
    if (name === "audit_status") {
      if (!audit) fail("AUDIT_UNAVAILABLE");
      return audit.status(p.id);
    }
    if (name === "audit_tail") {
      if (!audit) fail("AUDIT_UNAVAILABLE");
      return audit.tail(p.id, a.limit);
    }
    if (name === "large_prompt_plan") {
      return {
        device: config.id,
        project: p.id,
        ...planLargePrompt({
          prompt: a.prompt,
          chunkChars: a.chunkChars,
          ifNoneMatch: a.ifNoneMatch,
        }),
      };
    }
    if (name === "hyperspeed_plan") {
      const capacity = runner.capacity(p.files.root);
      return {
        device: config.id,
        project: p.id,
        ...planHyperSpeed({
          tasks: a.tasks,
          pools: a.pools,
          capacity,
          allowLocal: a.allowLocal,
        }),
      };
    }
    if (name === "project_progress")
      return {
        device: config.id,
        project: p.id,
        ...buildProjectProgress({
          sessions: runner.list(p.id, a.recentJobs),
          autopilotState: autopilot ? autopilot.status(p.id, 1) : null,
        }),
      };
    if (name === "execution_capacity")
      return {
        device: config.id,
        project: p.id,
        ...runner.capacity(p.files.root),
      };
    if (name === "verification_plan") {
      const changes = collectChangedPaths(p.files.root);
      const environment = detectProjectEnvironment(p.files);
      return {
        device: config.id,
        project: p.id,
        gitAvailable: changes.gitAvailable,
        changesTruncated: changes.truncated,
        ...selectVerificationPlan({
          changedPaths: changes.paths,
          gates: Object.keys(p.gates),
          gitAvailable: changes.gitAvailable,
          truncated: changes.truncated,
          environment,
        }),
      };
    }
    if (name === "chat_workspace_open") {
      // Everything is obtained from this same authorized agent/project.
      // Optional subsystems report UNAVAILABLE instead of inventing state.
      let explorer = null;
      let environment = null;
      let progress = null;
      let checkpoint = null;
      let browser = null;
      try {
        explorer = p.files.tree("", 2, a.maxEntries);
      } catch {}
      try {
        environment = detectProjectEnvironment(p.files);
      } catch {}
      try {
        const sessions = runner.list(p.id, a.recentJobs);
        progress = buildProjectProgress({
          sessions,
          autopilotState: autopilot ? autopilot.status(p.id, 1) : null,
        });
      } catch {}
      if (laneStateDir) {
        try {
          checkpoint = new CompactSessionStore(laneStateDir).resume(
            p.id,
            a.lane,
          );
        } catch {}
      }
      try {
        browser = browserRuntimeStatus();
      } catch {}
      return buildChatWorkspaceOpen({
        device: config.id,
        project: p.id,
        lane: a.lane,
        writable: p.writable,
        environment,
        explorer,
        progress,
        checkpoint,
        browser,
        qualityGates: Object.keys(p.gates),
        ifNoneMatch: a.ifNoneMatch,
      });
    }
    if (name === "workspace_home") {
      return {
        device: config.id,
        project: p.id,
        writable: p.writable,
        version: VERSION,
        environment: detectProjectEnvironment(p.files),
        explorer: p.files.tree("", a.maxDepth, a.maxEntries),
        sessions: runner.list(p.id, a.recentJobs),
        qualityGates: Object.keys(p.gates).sort(),
        nextActions: {
          browse: "project_tree",
          fileDetails: "project_file_info",
          sessions: "list_project_jobs",
          projectStatus: "project_snapshot",
          safeFolderCreation: "create_project_directory",
          guardedFileMove: "move_project_file",
          safeFileCopy: "copy_project_file",
        },
      };
    }
    if (name === "project_snapshot") {
      const listing = p.files.list("");
      const gitDir = path.join(p.files.root, ".git");
      let git = { available: false, status: null };
      try {
        const stat = fs.lstatSync(gitDir);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          const output = execFileSync(
            "git",
            [
              "--no-optional-locks",
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.untrackedCache=false",
              "status",
              "--porcelain=v1",
              "--branch",
              "--untracked-files=normal",
            ],
            {
              cwd: p.files.root,
              encoding: "utf8",
              timeout: 5000,
              maxBuffer: 32768,
              env: {
                PATH: process.env.PATH,
                SystemRoot: process.env.SystemRoot,
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL:
                  process.platform === "win32" ? "NUL" : "/dev/null",
                GIT_TERMINAL_PROMPT: "0",
                GIT_OPTIONAL_LOCKS: "0",
              },
            },
          );
          git = { available: true, status: redact(output) };
        }
      } catch {
        git = { available: false, status: null };
      }
      return {
        device: config.id,
        project: p.id,
        writable: p.writable,
        gates: Object.keys(p.gates),
        connection: "connected",
        version: VERSION,
        entries: listing.entries.slice(0, a.maxEntries),
        entriesTruncated: listing.entries.length > a.maxEntries,
        git,
      };
    }
    if (name === "list_directory") return p.files.list(a.path);
    if (name === "project_tree")
      return p.files.tree(a.path, a.maxDepth, a.maxEntries);
    if (name === "project_integrity_manifest")
      return p.files.integrityManifest(a.path, a.maxDepth, a.maxFiles);
    if (name === "project_file_info") return p.files.fileInfo(a.path);
    if (name === "checkpoint_create") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      return checkpoints().create(
        p.id,
        a.requestKey,
        a.path,
        a.expectedHash,
        p.files,
        (content) => redact(content) === content,
      );
    }
    if (name === "checkpoint_restore_plan")
      return checkpoints().restorePlan(p.id, a.requestKey, p.files);
    if (name === "create_project_directory") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      return p.files.createDirectory(a.path);
    }
    if (name === "move_project_file") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      return p.files.moveFile(a.from, a.to, a.expectedHash);
    }
    if (name === "copy_project_file") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      return p.files.copyFile(a.from, a.to, a.expectedHash);
    }
    if (name === "list_project_jobs")
      return runner.list(p.id, a.limit, { state: a.state, cursor: a.cursor });
    if (name === "repo_intelligence")
      return p.files.repoIntelligence(
        a.identifier,
        a.operation,
        a.maxFiles,
        a.maxResults,
      );
    if (name === "repo_map")
      return p.files.repoMap(a.query, a.maxFiles, a.maxSymbolsPerFile);
    if (name === "context_pack") {
      const budgets = {
        small: {
          maxBytes: 12288,
          maxFiles: 4,
          maxLines: 80,
          mapFiles: 20,
          symbols: 8,
        },
        medium: {
          maxBytes: 32768,
          maxFiles: 8,
          maxLines: 160,
          mapFiles: 40,
          symbols: 12,
        },
        deep: {
          maxBytes: 65536,
          maxFiles: 16,
          maxLines: 240,
          mapFiles: 80,
          symbols: 20,
        },
      };
      const budget = budgets[a.budget];
      const gitDir = path.join(p.files.root, ".git");
      let head = null;
      let statusRaw = "";
      let gitAvailable = false;
      try {
        const stat = fs.lstatSync(gitDir);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          const gitOptions = {
            cwd: p.files.root,
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 65536,
            env: {
              PATH: process.env.PATH,
              SystemRoot: process.env.SystemRoot,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL:
                process.platform === "win32" ? "NUL" : "/dev/null",
              GIT_TERMINAL_PROMPT: "0",
              GIT_OPTIONAL_LOCKS: "0",
            },
          };
          head = execFileSync(
            "git",
            [
              "--no-optional-locks",
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.untrackedCache=false",
              "rev-parse",
              "--verify",
              "HEAD",
            ],
            gitOptions,
          ).trim();
          statusRaw = execFileSync(
            "git",
            [
              "--no-optional-locks",
              "-c",
              "core.fsmonitor=false",
              "-c",
              "core.untrackedCache=false",
              "status",
              "--porcelain=v1",
              "--untracked-files=normal",
            ],
            gitOptions,
          );
          gitAvailable = true;
        }
      } catch {
        gitAvailable = false;
        head = null;
        statusRaw = "";
      }

      const changedFiles = [];
      const changedSet = new Set();
      if (gitAvailable) {
        for (const line of statusRaw.split("\n")) {
          if (line.length < 4) continue;
          let relative = line.slice(3).trim();
          const rename = relative.lastIndexOf(" -> ");
          if (rename >= 0) relative = relative.slice(rename + 4);
          relative = relative.replaceAll("\\", "/");
          if (!relative || changedSet.has(relative)) continue;
          try {
            p.files.read(relative);
          } catch {
            continue;
          }
          changedSet.add(relative);
          changedFiles.push(relative);
        }
      }

      const map = p.files.repoMap(a.query, budget.mapFiles, budget.symbols);
      const mapByPath = new Map(map.files.map((file) => [file.path, file]));
      const candidates = [];
      const seen = new Set();
      for (const relative of changedFiles) {
        candidates.push(relative);
        seen.add(relative);
      }
      for (const file of map.files) {
        if (seen.has(file.path)) continue;
        candidates.push(file.path);
        seen.add(file.path);
      }

      const excerpts = [];
      let bytes = 0;
      const query = a.query.trim().toLowerCase();
      for (const relative of candidates) {
        if (excerpts.length >= budget.maxFiles || bytes >= budget.maxBytes)
          break;
        const mapEntry = mapByPath.get(relative);
        const matchingSymbol =
          query && mapEntry
            ? mapEntry.symbols.find((symbol) =>
                symbol.name.toLowerCase().includes(query),
              )
            : null;
        const startLine = Math.max(
          1,
          matchingSymbol
            ? matchingSymbol.line - Math.floor(budget.maxLines / 4)
            : 1,
        );

        let file;
        try {
          file = p.files.readRange(relative, startLine, budget.maxLines);
        } catch {
          continue;
        }
        const redactedContent = redact(file.content);
        const wasRedacted = redactedContent !== file.content;
        let text = redactedContent;
        const remaining = budget.maxBytes - bytes;
        let excerptTruncated = false;
        if (Buffer.byteLength(text, "utf8") > remaining) {
          const buffer = Buffer.from(text, "utf8");
          text = buffer.subarray(0, remaining).toString("utf8");
          while (Buffer.byteLength(text, "utf8") > remaining)
            text = text.slice(0, -1);
          excerptTruncated = true;
        }
        const excerptBytes = Buffer.byteLength(text, "utf8");
        if (!excerptBytes) continue;
        bytes += excerptBytes;
        excerpts.push({
          path: relative,
          sha256: file.sha256,
          startLine: file.startLine,
          endLine: file.endLine,
          hasMore: file.hasMore || excerptTruncated,
          changed: changedSet.has(relative),
          symbols: mapEntry?.symbols ?? [],
          content: text,
          redacted: wasRedacted,
          bytes: excerptBytes,
        });
      }

      const statusHash = createHash("sha256").update(statusRaw).digest("hex");
      const contextKey = createHash("sha256")
        .update(
          JSON.stringify({
            head,
            statusHash,
            query: a.query,
            budget: a.budget,
            files: excerpts.map((file) => ({
              path: file.path,
              sha256: file.sha256,
              startLine: file.startLine,
              endLine: file.endLine,
            })),
          }),
        )
        .digest("hex");

      return {
        query: a.query,
        budget: a.budget,
        budgetBytes: budget.maxBytes,
        bytes,
        contextKey,
        cacheable: true,
        git: {
          available: gitAvailable,
          head,
          dirty: statusRaw.trim().length > 0,
          statusHash,
        },
        changedFiles,
        files: excerpts,
        count: excerpts.length,
        map: {
          candidateFiles: map.candidateFiles,
          scannedBytes: map.scannedBytes,
          truncated: map.truncated,
        },
      };
    }
    if (name === "read_file") {
      const r = p.files.read(a.path);
      return {
        ...r,
        content: redact(r.content),
        redacted: redact(r.content) !== r.content,
      };
    }
    if (name === "read_file_tail") {
      const r = p.files.readTail(a.path, a.maxLines);
      const content = redact(r.content);
      return { ...r, content, redacted: content !== r.content };
    }
    if (name === "read_file_range") {
      const r = p.files.readRange(a.path, a.startLine, a.maxLines);
      return {
        ...r,
        content: redact(r.content),
        redacted: redact(r.content) !== r.content,
      };
    }
    if (name === "read_files_batch") {
      const files = a.files.map((item) => {
        const r =
          item.startLine === undefined && item.maxLines === undefined
            ? p.files.read(item.path)
            : p.files.readRange(
                item.path,
                item.startLine ?? 1,
                item.maxLines ?? 200,
              );
        const content = redact(r.content);
        return { ...r, content, redacted: content !== r.content };
      });
      return { files, count: files.length };
    }
    if (
      ["hyperindex_status", "hyperindex_build", "hyperindex_search"].includes(
        name,
      )
    )
      return hyperIndexOperation(name, {
        files: p.files,
        stateDir: config.stateDir,
        project: p.id,
        query: a.query,
        maxResults: a.maxResults,
      });
    if (name === "search_code") {
      const r = p.files.search(a.query, {
        maxResults: a.maxResults,
        pathPrefix: a.pathPrefix,
        caseSensitive: a.caseSensitive,
        extensions: a.extensions,
      });
      return {
        ...r,
        matches: r.matches.map((m) => ({ ...m, text: redact(m.text) })),
      };
    }
    if (name === "model_route_plan")
      return planSmartModelRoute({
        models: a.models,
        task: a.task,
        state: a.quotaState,
      });
    if (name === "skill_recommendations")
      return {
        skills: selectSkillPacks({
          objective: a.objective,
          changedFiles: a.changedFiles,
          failureSummary: a.failureSummary,
        }),
        ...(a.observations === undefined
          ? {}
          : {
              observer: evaluateEngineeringObservations({
                project: p.id,
                observations: a.observations,
              }),
            }),
      };
    if (name.startsWith("mission_") && !autopilot)
      fail("AUTOPILOT_UNAVAILABLE");
    if (name === "mission_compile")
      return autopilot.compileMission({
        project: p.id,
        key: a.key,
        objective: a.objective,
        acceptanceCriteria: a.acceptanceCriteria,
        requirements: a.requirements,
        tasks: a.tasks,
        ownerGates: a.ownerGates,
        definitionOfDone: a.definitionOfDone,
        aiBudget: a.aiBudget,
      });
    if (name === "mission_status")
      return autopilot.missionStatus(a.mission, p.id);
    if (name === "mission_evidence")
      return autopilot.missionEvidence(
        a.mission,
        p.id,
        a.criterionIndex,
        a.evidence,
      );
    if (name.startsWith("autopilot_") && !autopilot)
      fail("AUTOPILOT_UNAVAILABLE");
    if (name === "autopilot_worker_runtime_status") {
      const source =
        typeof workerRuntimeSource === "function"
          ? workerRuntimeSource()
          : null;
      const observed = (kind) =>
        source === null || !Array.isArray(source[kind])
          ? null
          : source[kind].includes(p.id);
      return {
        device: config.id,
        project: p.id,
        runtimeVersion: VERSION,
        processAvailable: source !== null && source.agentRunning === true,
        evidence:
          source === null ? "NOT_INSTRUMENTED" : "ACTIVE_AGENT_WORKER_HANDLES",
        workers: {
          gate: {
            configured: p.autopilotGateWorker?.enabled === true,
            loopStarted: observed("gate"),
          },
          repair: {
            configured: p.autopilotRepairWorker?.enabled === true,
            loopStarted: observed("repair"),
          },
          githubCiWatch: {
            configured: p.autopilotCiWatch?.enabled === true,
            loopStarted: observed("githubCiWatch"),
          },
          localDraft: {
            configured: p.autopilotLocalWorker?.enabled === true,
            loopStarted: observed("localDraft"),
          },
          coding: {
            configured:
              p.autopilotCodingWorker?.enabled === true &&
              p.autopilotCodingWorker?.localProcessingApproved === true,
            localProcessingApproved:
              p.autopilotCodingWorker?.localProcessingApproved === true,
            loopStarted: observed("coding"),
          },
        },
        note: "Loop started is not evidence of successful CI polling, a completed fix, service uptime or deployment.",
      };
    }
    if (name === "autopilot_status") return autopilot.status(p.id, a.limit);
    if (name === "autopilot_continuation_status") {
      const source =
        typeof workerRuntimeSource === "function"
          ? workerRuntimeSource()
          : null;
      return {
        device: config.id,
        project: p.id,
        ...(source && typeof source.continuationStatus === "function"
          ? source.continuationStatus(p.id)
          : {
              installed: false,
              source: "NOT_INSTRUMENTED",
              deliveredThisProcess: null,
              lastError: null,
              automaticChatWake: false,
              backgroundInference: false,
            }),
        next: autopilot.status(p.id, 1).next?.id ?? null,
      };
    }
    if (name === "autopilot_repair_candidate")
      return reviewRepairCandidate({
        project: p,
        journal: autopilot,
        lanes: worktreeLanes(),
        taskId: a.task,
        includePatch: a.includePatch,
      });
    if (name === "autopilot_enqueue") {
      if (!canQueueAutopilotGate(a.key, permissions)) fail("ACCESS_DENIED");
      return autopilot.enqueue({
        project: p.id,
        key: a.key,
        objective: a.objective,
        priority: a.priority,
        dependsOn: a.dependsOn,
      });
    }
    if (name === "autopilot_claim") {
      const claimed = autopilot.claim(p.id, { holder: a.holder });
      // Never acknowledge a claim that a worker cannot fence. This catches
      // mixed-version/incorrect journal integrations before a caller attempts
      // an unsafe tokenless checkpoint or completion.
      if (
        claimed !== null &&
        (claimed.state !== "running" ||
          !z.string().uuid().safeParse(claimed.leaseToken).success ||
          claimed.lease?.holder !== (a.holder ?? null))
      )
        fail("AUTOPILOT_CLAIM_CONTRACT_INVALID");
      return claimed;
    }
    if (name === "autopilot_local_draft") {
      const task = autopilot.get(a.task, p.id);
      if (task.state !== "running") fail("AUTOPILOT_TASK_NOT_RUNNING");
      // Fail fast on a stale or missing lease, before spending local
      // inference time on a proposal this caller is not allowed to save.
      autopilot.assertLease(task, a.leaseToken);
      const existing = task.checkpoint;
      if (existing) {
        if (existing.next !== "LOCAL_DRAFT_AWAITING_REVIEW")
          fail("AUTOPILOT_CHECKPOINT_EXISTS");
        return {
          device: config.id,
          project: p.id,
          task: task.id,
          proposal: existing.summary,
          checkpointAt: existing.at,
          reused: true,
          writesApplied: false,
          paidInference: false,
          reviewRequired: true,
          modelUsage: existing.modelUsage ?? unknownModelReceipt(),
          modelUsageReusedFromCheckpoint: existing.modelUsage !== undefined,
        };
      }
      const prompt = [
        "KMJ CodeBridge OFFLINE TASK DRAFT. You are generating UNTRUSTED advice.",
        "Do not claim to have run commands, tests or edits.",
        "Do not request credentials or publish private code.",
        "Return concise implementation steps and a test plan for human/AI review.",
        "TASK:",
        task.objective.slice(0, 3000),
      ].join("\n");
      const generated = await offlineModel().generate({
        model: a.model,
        prompt,
        maxTokens: a.maxTokens,
        timeoutSeconds: a.timeoutSeconds,
      });
      const proposal = redact(generated.response ?? "").slice(0, 4096);
      if (!proposal.trim()) fail("AUTOPILOT_LOCAL_DRAFT_EMPTY");
      const usage = localModelReceipt(a.model, "autopilot_local_draft");
      const saved = autopilot.checkpoint(a.task, p.id, {
        summary: proposal,
        next: "LOCAL_DRAFT_AWAITING_REVIEW",
        leaseToken: a.leaseToken,
        modelUsage: usage,
      });
      rememberModel(p.id, usage);
      return {
        device: config.id,
        project: p.id,
        task: saved.id,
        proposal: saved.checkpoint.summary,
        checkpointAt: saved.checkpoint.at,
        hitTokenLimit: generated.hitTokenLimit === true,
        reused: false,
        writesApplied: false,
        paidInference: false,
        reviewRequired: true,
        modelUsage: saved.checkpoint.modelUsage,
        modelUsageReusedFromCheckpoint: false,
        next: "Use guarded CodeBridge edits and configured quality gates before completion",
      };
    }
    if (name === "autopilot_checkpoint")
      return autopilot.checkpoint(a.task, p.id, {
        summary: a.summary,
        next: a.next,
        leaseToken: a.leaseToken,
      });
    if (name === "autopilot_wait") {
      // Release the current task's lease first; an authorized blocked task must
      // never hold up independent queued work. A recovery task is metadata only.
      const waiting = autopilot.wait(a.task, p.id, a.reason, a.leaseToken);
      if (!a.blockerCode) return waiting;
      const recoverySpec = remediationTaskForBlocker(a.blockerCode, a.task);
      try {
        const recovery = autopilot.enqueue({
          project: p.id,
          ...recoverySpec,
        });
        return {
          ...waiting,
          remediation: {
            task: recovery.id,
            state: recovery.state,
            queued: true,
            executionStarted: false,
            blockerCode: a.blockerCode,
          },
        };
      } catch {
        // Original wait is already durable. A full journal or idempotency
        // conflict is reported, not turned into fake success.
        return {
          ...waiting,
          remediation: {
            queued: false,
            executionStarted: false,
            blockerCode: a.blockerCode,
            error: "RECOVERY_QUEUE_UNAVAILABLE",
          },
        };
      }
    }
    if (name === "autopilot_resume") return autopilot.resume(a.task, p.id);
    if (name === "autopilot_complete")
      return autopilot.complete(a.task, p.id, {
        state: a.state,
        result: a.result,
        leaseToken: a.leaseToken,
      });
    if (name.startsWith("supervisor_") && !supervisor)
      fail("SUPERVISOR_UNAVAILABLE");
    if (name === "supervisor_status")
      return await supervisor.request({ op: "status", service: a.service });
    if (name === "supervisor_logs")
      return await supervisor.request({
        op: "logs",
        service: a.service,
        lines: a.lines,
      });
    if (name === "supervisor_config_validate")
      return await supervisor.request({
        op: "config_validate",
        service: a.service,
      });
    if (name === "supervisor_disk_space")
      return await supervisor.request({ op: "disk_space" });
    if (name === "supervisor_project_status")
      return await supervisor.request({
        op: "project_status",
        projectId: a.project,
      });
    if (name === "supervisor_device_status")
      return await supervisor.request({ op: "device_status" });
    if (name === "supervisor_main_platform_production_status") {
      if (a.project !== "kmj-main-platform") fail("ACCESS_DENIED");
      return await supervisor.request({
        op: "main_platform_production_status",
      });
    }
    if (name === "supervisor_main_platform_maintenance_status") {
      if (a.project !== "kmj-main-platform") fail("ACCESS_DENIED");
      return await supervisor.request({
        op: "main_platform_maintenance_status",
      });
    }
    if (name === "supervisor_main_platform_production_activate") {
      if (a.project !== "kmj-main-platform") fail("ACCESS_DENIED");
      return await supervisor.request({
        op: "main_platform_production_activate",
        approvedSha: a.approvedSha,
        expectedCurrentRelease: a.expectedCurrentRelease,
        confirmation: a.confirmation,
      });
    }
    if (name === "supervisor_main_platform_refresh_status")
      return await supervisor.request({ op: "main_platform_refresh_status" });
    if (name === "supervisor_main_platform_refresh")
      return await supervisor.request({ op: "main_platform_refresh" });
    if (name === "supervisor_private_pr322_ci_status")
      return await supervisor.request({ op: "private_pr322_ci_status" });
    if (name === "supervisor_private_pr322_ci_start")
      return await supervisor.request({ op: "private_pr322_ci_start" });
    if (name === "supervisor_private_pr337_ci_status")
      return await supervisor.request({ op: "private_pr337_ci_status" });
    if (name === "supervisor_private_pr337_ci_start")
      return await supervisor.request({ op: "private_pr337_ci_start" });
    if (name === "supervisor_private_pr419_ci_status")
      return await supervisor.request({ op: "private_pr419_ci_status" });
    if (name === "supervisor_private_pr419_ci_start")
      return await supervisor.request({ op: "private_pr419_ci_start" });
    if (name === "supervisor_update_status")
      return await supervisor.request({ op: "update_status" });
    if (name === "supervisor_update_check")
      return await supervisor.request({ op: "update_check" });
    if (name === "supervisor_release_history")
      return await supervisor.request({ op: "release_history" });
    if (name === "supervisor_update_rollback")
      return await supervisor.request({ op: "update_rollback" });
    if (name === "supervisor_update_now")
      return await supervisor.request({ op: "update_now" });
    if (name === "supervisor_restart")
      return await supervisor.request({ op: "restart", service: a.service });
    if (name === "preview_file")
      return p.files.preview(a.path, a.content, a.expectedHash);
    if (name === "write_file") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      if (laneStateDir) lanes().assertWritable(p.id, [a.path], a.leaseToken);
      if (a.expectedHash !== null) {
        const before = p.files.read(a.path);
        if (!preservesSensitiveBindings(before.content, a.content))
          fail("SENSITIVE_CONTENT_PROTECTED");
      }
      return p.files.write(a.path, a.content, a.expectedHash);
    }
    if (name === "edit_file") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      if (laneStateDir) lanes().assertWritable(p.id, [a.path], a.leaseToken);
      const before = p.files.read(a.path);
      if (before.sha256 !== a.expectedHash) fail("CONTENT_CONFLICT");
      const first = before.content.indexOf(a.oldText);
      if (first < 0) fail("EDIT_TEXT_NOT_FOUND");
      if (before.content.indexOf(a.oldText, first + a.oldText.length) >= 0)
        fail("EDIT_TEXT_AMBIGUOUS");
      const after =
        before.content.slice(0, first) +
        a.newText +
        before.content.slice(first + a.oldText.length);
      if (!preservesSensitiveBindings(before.content, after))
        fail("SENSITIVE_CONTENT_PROTECTED");
      return p.files.edit(a.path, a.oldText, a.newText, a.expectedHash);
    }
    if (name === "write_files_atomic") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      if (laneStateDir)
        lanes().assertWritable(
          p.id,
          a.changes.map((change) => change.path),
          a.leaseToken,
        );
      for (const change of a.changes) {
        if (change.expectedHash === null) continue;
        const before = p.files.read(change.path);
        if (!preservesSensitiveBindings(before.content, change.content))
          fail("SENSITIVE_CONTENT_PROTECTED");
      }
      return p.files.writeBatch(a.changes);
    }
    if (name === "git_index_probe") {
      // Inspect, never refresh the index or alter a source file. In
      // particular do not invoke user-defined diff/smudge/clean helpers.
      // The project file policy guards traversal, sensitive files and size.
      const snapshot = p.files.read(a.path);
      const gitDir = path.join(p.files.root, ".git");
      let gitStat;
      try {
        gitStat = fs.lstatSync(gitDir);
      } catch {
        fail("GIT_ROOT_OUTSIDE_PROJECT");
      }
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
        fail("GIT_ROOT_OUTSIDE_PROJECT");
      const gitEnv = {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      };
      let indexed;
      try {
        indexed = execFileSync(
          "git",
          [
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "ls-files",
            "--stage",
            "-z",
            "--",
            a.path,
          ],
          {
            cwd: p.files.root,
            encoding: "utf8",
            maxBuffer: 8192,
            timeout: 5000,
            env: gitEnv,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch {
        fail("GIT_INDEX_PROBE_FAILED");
      }
      const entries = indexed.split("\0").filter(Boolean);
      if (entries.length !== 1) fail("GIT_INDEX_PROBE_NOT_SINGLE_TRACKED_FILE");
      const fields = entries[0].match(
        /^(100644|100755) ([a-f0-9]{40,64}) 0\t(.+)$/,
      );
      if (
        !fields ||
        fields[3].replaceAll("\\", "/") !== a.path.replaceAll("\\", "/")
      )
        fail("GIT_INDEX_PROBE_INVALID_ENTRY");
      const blobHash = (contents) => {
        const buffer = Buffer.from(contents, "utf8");
        return createHash(fields[2].length === 64 ? "sha256" : "sha1")
          .update(Buffer.from(`blob ${buffer.length}\0`, "utf8"))
          .update(buffer)
          .digest("hex");
      };
      const worktreeRawBlob = blobHash(snapshot.content);
      const normalizedLfBlob = blobHash(
        snapshot.content.replace(/\r\n/g, "\n"),
      );
      return {
        path: a.path,
        indexBlob: fields[2],
        indexMode: fields[1],
        rawBlob: worktreeRawBlob,
        normalizedLfBlob,
        rawEqualsIndex: fields[2] === worktreeRawBlob,
        lfNormalizedEqualsIndex: fields[2] === normalizedLfBlob,
        hasCrLf: snapshot.content.includes("\r\n"),
        worktreeSha256: snapshot.sha256,
        indexChanged: false,
      };
    }
    if (name === "git_reconcile_main") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      const gitDir = path.join(p.files.root, ".git");
      let gitStat;
      try {
        gitStat = fs.lstatSync(gitDir);
      } catch {
        fail("GIT_ROOT_OUTSIDE_PROJECT");
      }
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
        fail("GIT_ROOT_OUTSIDE_PROJECT");
      const common = [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
      ];
      const gitEnv = {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      };
      const runGit = (args, timeout = 5000) =>
        execFileSync("git", [...common, ...args], {
          cwd: p.files.root,
          encoding: "utf8",
          timeout,
          maxBuffer: 32768,
          env: gitEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
      let branch;
      try {
        branch = runGit(["symbolic-ref", "--short", "HEAD"]).trim();
      } catch {
        fail("GIT_RECONCILE_BRANCH_FAILED");
      }
      if (branch !== "main") fail("GIT_RECONCILE_NOT_MAIN");
      try {
        runGit(["fetch", "--no-tags", "origin", "main"], 120000);
      } catch {
        fail("GIT_RECONCILE_FETCH_FAILED");
      }
      let remoteHead;
      try {
        remoteHead = runGit(["rev-parse", "origin/main"]).trim();
      } catch {
        fail("GIT_RECONCILE_REMOTE_FAILED");
      }
      if (remoteHead !== a.expectedRemoteHead)
        fail("GIT_RECONCILE_REMOTE_CHANGED");
      let untracked;
      try {
        untracked = runGit([
          "ls-files",
          "--others",
          "--exclude-standard",
        ]).trim();
      } catch {
        fail("GIT_RECONCILE_CHECK_FAILED");
      }
      if (untracked) fail("GIT_RECONCILE_UNTRACKED");
      // The index must be pristine. Never discard staged changes, even if
      // the working tree happens to match a fetched commit.
      const matchesRevision = (args) => {
        try {
          runGit(args);
          return true;
        } catch (error) {
          if (error?.status === 1) return false;
          fail("GIT_RECONCILE_CHECK_FAILED");
        }
      };
      if (!matchesRevision(["diff", "--cached", "--quiet", "HEAD", "--"]))
        fail("GIT_RECONCILE_CONTENT_MISMATCH");
      const alreadyMatchesRemote = matchesRevision([
        "diff",
        "--quiet",
        a.expectedRemoteHead,
        "--",
      ]);
      const cleanCurrentHead = matchesRevision([
        "diff",
        "--quiet",
        "HEAD",
        "--",
      ]);
      if (!alreadyMatchesRemote && !cleanCurrentHead)
        fail("GIT_RECONCILE_CONTENT_MISMATCH");
      // A clean checkout is safe to fast-forward without first writing all
      // newer tracked bytes into it. Never silently rewind or diverge.
      try {
        runGit(["merge-base", "--is-ancestor", "HEAD", a.expectedRemoteHead]);
      } catch (error) {
        if (error?.status === 1) fail("GIT_RECONCILE_NON_FAST_FORWARD");
        fail("GIT_RECONCILE_CHECK_FAILED");
      }
      try {
        if (alreadyMatchesRemote) {
          // Retain the existing hash-guarded content-reconciliation path.
          runGit(["reset", "--hard", a.expectedRemoteHead]);
        } else {
          // Unlike reset --hard, ff-only merge refuses a concurrent dirty
          // worktree; no remote divergence, rebase or forced checkout.
          runGit(["merge", "--ff-only", a.expectedRemoteHead], 120000);
        }
      } catch {
        fail("GIT_RECONCILE_ADVANCE_FAILED");
      }
      let head;
      try {
        head = runGit(["rev-parse", "HEAD"]).trim();
      } catch {
        fail("GIT_RECONCILE_VERIFY_FAILED");
      }
      if (head !== a.expectedRemoteHead) fail("GIT_RECONCILE_VERIFY_FAILED");
      return { reconciled: true, head };
    }
    if (
      name === "git_status" ||
      name === "git_diff" ||
      name === "git_log" ||
      name === "git_show"
    ) {
      const gitDir = path.join(p.files.root, ".git");
      let gitStat;
      try {
        gitStat = fs.lstatSync(gitDir);
      } catch {
        fail("GIT_ROOT_OUTSIDE_PROJECT");
      }
      if (!gitStat.isDirectory() || gitStat.isSymbolicLink())
        fail("GIT_ROOT_OUTSIDE_PROJECT");
      try {
        const common = [
          "--no-optional-locks",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.untrackedCache=false",
        ];
        const args =
          name === "git_diff"
            ? [
                ...common,
                "-c",
                "diff.external=",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--patch",
                "--",
              ]
            : name === "git_log"
              ? [
                  ...common,
                  "log",
                  `-${a.limit}`,
                  "--date=iso-strict",
                  "--pretty=format:%H%x09%ad%x09%an%x09%s",
                  "--no-decorate",
                ]
              : name === "git_show"
                ? [
                    ...common,
                    "-c",
                    "diff.external=",
                    "show",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--date=iso-strict",
                    "--format=fuller",
                    "--patch",
                    "--stat",
                    a.commit,
                    "--",
                  ]
                : [
                    ...common,
                    "status",
                    "--porcelain=v1",
                    "--branch",
                    "--untracked-files=normal",
                  ];
        const output = execFileSync("git", args, {
          cwd: p.files.root,
          encoding: "utf8",
          timeout: 5000,
          maxBuffer:
            name === "git_diff" || name === "git_show" ? 131072 : 32768,
          env: {
            PATH: process.env.PATH,
            SystemRoot: process.env.SystemRoot,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL:
              process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
          },
        });
        const redacted = redact(output);
        if (name === "git_diff" || name === "git_show") {
          const bytes = Buffer.from(redacted);
          const truncated = bytes.length > 65536;
          const text = truncated
            ? bytes.subarray(0, 65536).toString("utf8")
            : redacted;
          return name === "git_diff"
            ? { diff: text, truncated }
            : { show: text, truncated };
        }
        if (name === "git_log") return { log: redacted };
        return { status: redacted };
      } catch {
        fail(
          name === "git_diff"
            ? "GIT_DIFF_FAILED"
            : name === "git_log"
              ? "GIT_LOG_FAILED"
              : name === "git_show"
                ? "GIT_SHOW_FAILED"
                : "GIT_STATUS_FAILED",
        );
      }
    }
    if (name === "list_project_commands")
      return {
        commands: [
          ...Object.entries(p.commands ?? {}).map(([id, profile]) => ({
            id,
            category: profile.category,
            description: profile.description,
            risk: commandRisk(profile.category),
            approvalRequired: approvalRequired(commandRisk(profile.category)),
            variants: Object.keys(profile.variants),
          })),
          // First-party compatibility profile for clients whose captured MCP
          // tool list omits the newer browser_qa_start operation.
          ...(p.id === "kmj-main-platform" && p.writable
            ? [
                {
                  id: "browser_public_qa",
                  category: "build",
                  description:
                    "Start fixed-origin anonymous Chrome QA via the existing run_project_command tool. Nine private screenshots and SHA-256 receipts; no arbitrary URL, login, shell, or sandbox bypass.",
                  risk: "TEST",
                  approvalRequired: false,
                  variants: ["start"],
                },
                {
                  id: "main_platform_ui_deps",
                  category: "build",
                  description:
                    "Explicitly install SHA-pinned frontend dependencies into the private Main Platform CI worktree. Uses committed apps/platform/package-lock.json, ignores npm lifecycle scripts and never modifies the shared checkout.",
                  risk: "TEST",
                  approvalRequired: false,
                  variants: ["ci"],
                },
                {
                  id: "main_platform_php_deps",
                  category: "build",
                  description:
                    "Explicit, SHA-pinned PHP Composer install (ci) or Wayfinder route generation (routes) in the same private Main Platform CI worktree. Fixed argv, no Composer plugins/scripts, no production env/DB or shared checkout.",
                  risk: "TEST",
                  approvalRequired: false,
                  variants: ["ci", "routes"],
                },
              ]
            : []),
          // Existing clients can invoke this fixed read-only supervisor
          // inventory without recapturing a new MCP tool catalog. Unlike
          // starting a backup, it NEVER starts a service or approves release.
          ...(p.id === "kmj-main-platform" &&
          p.writable &&
          config.id === "kmj-elite-main-platform" &&
          supervisor
            ? [
                {
                  id: "main_platform_offsite_status",
                  category: "inspect",
                  description:
                    "Read fixed KMJ-elite backup and health service/timer status via the approved root supervisor; no file contents, SSH access, transfer, restore, or release approval.",
                  risk: "READ",
                  approvalRequired: false,
                  variants: ["overview"],
                },
              ]
            : []),
          // Host-specific read-only storage inventory without root/sudo or
          // arbitrary args; supported even when the privileged supervisor is
          // not installed. Requires the existing project execute permission.
          ...(p.id === "kmj-cloudos" && p.writable && config.id === "google-vps"
            ? [
                {
                  id: "cloudos_host_storage_audit",
                  category: "inspect",
                  description:
                    "Read fixed Google VPS disk and CloudOS service sizes without sudo, file changes, arbitrary shell, or production release credit.",
                  risk: "READ",
                  approvalRequired: false,
                  variants: ["overview"],
                },
              ]
            : []),
          // CloudOS already has an authorized QA runner, but older installed
          // agents report commands: [] and the shared checkout is dirty.
          // Expose a fixed, supervisor-independent, HEAD-pinned test lane.
          ...(p.id === "kmj-cloudos" && p.writable && p.gates?.full
            ? [
                {
                  id: "cloudos_release_qa",
                  category: "build",
                  description:
                    "Run CloudOS Python regression tests only in a detached, immutable-HEAD Git worktree; never the dirty shared checkout. This is NOT production release-gate credit.",
                  risk: "TEST",
                  approvalRequired: false,
                  variants: ["full"],
                },
              ]
            : []),
        ],
      };
    // An optional laneId resolves only to a worktree this project already
    // prepared; the job label records the lane so receipts show where it ran.
    const laneCwd = (laneId) => {
      if (laneId === undefined) return p.files.root;
      const lane = worktreeLanes()
        .entries(p.id, p.files.root)
        .find((row) => row.laneId === laneId);
      if (!lane) fail("WORKTREE_NOT_FOUND");
      return lane.path;
    };
    const laneLabel = (label, laneId) =>
      laneId !== undefined ? `${label}@${laneId}` : label;
    if (name === "ide_run_project_task") {
      // Only already-approved configured profiles. Do not expose the special
      // built-in supervisors or any caller-specified executable/shell.
      if (!permissions.includes("read")) fail("ACCESS_DENIED");
      const profile = (p.commands ?? {})[a.command];
      if (!profile || !Object.hasOwn(profile.variants ?? {}, a.variant))
        fail("IDE_COMMAND_NOT_CONFIGURED");
      const existing = await dispatchCore(
        "run_project_command",
        {
          device: a.device,
          project: p.id,
          command: a.command,
          variant: a.variant,
          requestKey: a.requestKey,
          ...(a.laneId === undefined ? {} : { laneId: a.laneId }),
          ...(a.expectedHead === undefined
            ? {}
            : { expectedHead: a.expectedHead }),
        },
        permissions,
      );
      if (!existing || typeof existing.id !== "string")
        fail("IDE_JOB_UNAVAILABLE");
      const state = await dispatchCore(
        "get_job_status",
        {
          device: a.device,
          project: p.id,
          job: existing.id,
          waitMs: a.waitMs,
          tailChars: 8192,
        },
        permissions,
      );
      return compactIdeJobReceipt(state);
    }
    if (name === "ide_job_receipt") {
      const state = await dispatchCore(
        "get_job_status",
        {
          device: a.device,
          project: p.id,
          job: a.job,
          waitMs: a.waitMs,
          tailChars: 8192,
        },
        permissions,
      );
      return compactIdeJobReceipt(state);
    }
    if (name === "run_project_command") {
      // The CloudOS project has no administrator-configured command profiles
      // on its existing enrolled VPS, while the shared libvirt checkout is
      // dirty. Keep this compatible with older MCP clients and require the
      // existing execute grant. No root supervisor, shell, caller-selected
      // path/ref/args or deployment is needed.
      if (a.command === "main_platform_offsite_status") {
        if (
          a.variant !== "overview" ||
          a.laneId !== undefined ||
          a.expectedHead !== undefined
        )
          fail("COMMAND_NOT_ALLOWED");
        if (
          p.id !== "kmj-main-platform" ||
          config.id !== "kmj-elite-main-platform" ||
          !p.writable
        )
          fail("MAIN_PLATFORM_OFFSITE_STATUS_NOT_AUTHORIZED");
        if (!supervisor) fail("SUPERVISOR_UNAVAILABLE");
        // An installed supervisor returns fixed unit metadata only. Never
        // trust it as backup, restore, offsite transfer, or rollback evidence.
        // Avoid forwarding extra/unexpected fields from its response.
        const received = await supervisor.request({
          op: "main_platform_maintenance_status",
        });
        const state = received?.response ?? received;
        const service = state?.services?.offsiteBackup;
        const timer = state?.services?.offsiteBackupTimer;
        const health = state?.services?.healthCheck;
        const safe = (unit) => ({
          installed: unit?.installed === true,
          activeState: ["active", "inactive", "failed"].includes(
            unit?.activeState,
          )
            ? unit.activeState
            : "unknown",
          result: ["success", "exit-code", "signal", "timeout"].includes(
            unit?.result,
          )
            ? unit.result
            : "unknown",
          execMainStatus:
            typeof unit?.execMainStatus === "string" &&
            /^(?:0|[1-9][0-9]{0,2})$/.test(unit.execMainStatus)
              ? unit.execMainStatus
              : null,
        });
        return {
          command: "main_platform_offsite_status",
          mode: "READ_ONLY",
          backupService: safe(service),
          backupTimer: safe(timer),
          healthCheck: safe(health),
          // Always explicitly distinguish service success from independent
          // proof of the current candidate's encrypted remote recovery.
          candidateEncryptedOffsiteVerified: false,
          independentRestoreVerified: false,
          rollbackVerified: false,
          productionApprovalChanged: false,
        };
      }
      if (a.command === "cloudos_host_storage_audit") {
        if (
          a.variant !== "overview" ||
          a.laneId !== undefined ||
          a.expectedHead !== undefined
        )
          fail("COMMAND_NOT_ALLOWED");
        if (p.id !== "kmj-cloudos" || config.id !== "google-vps" || !p.writable)
          fail("CLOUDOS_HOST_AUDIT_NOT_AUTHORIZED");
        return runner.run({
          project: p.id,
          gate: "command:cloudos_host_storage_audit:overview:inspect",
          key: a.requestKey,
          cwd: p.files.root,
          command: "python3",
          args: ["-I", "-B", "-c", CLOUDOS_HOST_STORAGE_AUDIT_PYTHON],
          timeoutMs: 180000,
        });
      }
      if (a.command === "cloudos_release_qa") {
        if (
          a.variant !== "full" ||
          a.laneId !== undefined ||
          a.expectedHead !== undefined
        )
          fail("COMMAND_NOT_ALLOWED");
        if (p.id !== "kmj-cloudos" || !p.writable)
          fail("CLOUDOS_QA_PROJECT_NOT_ALLOWED");
        const approvedFullGate = p.gates?.full;
        if (!approvedFullGate) fail("CLOUDOS_QA_GATE_NOT_CONFIGURED");
        const lane = worktreeLanes().prepareCurrentHead(
          p.id,
          p.files.root,
          "cloudos_qa",
        );
        const validate = () => {
          const row = worktreeLanes()
            .entries(p.id, p.files.root)
            .find((item) => item.laneId === lane.laneId);
          if (!row || row.head !== lane.head) fail("WORKTREE_HEAD_MISMATCH");
          if (row.dirty) fail("WORKTREE_HAS_UNSAVED_WORK");
          for (const name of [
            "KMJ_CloudOS_Phase1_COMPLETE_Release_Gates_v1.2.yaml",
            "KMJ_CloudOS_Phase2_COMPLETE_Release_Gates_v2.0.yaml",
          ]) {
            const file = path.join(row.path, name);
            let stat;
            try {
              stat = fs.lstatSync(file);
            } catch {
              fail("CLOUDOS_QA_MANIFEST_MISSING");
            }
            if (!stat.isFile() || stat.isSymbolicLink())
              fail("CLOUDOS_QA_MANIFEST_UNSAFE");
          }
          const testDir = path.join(row.path, "tests");
          let stat;
          try {
            stat = fs.lstatSync(testDir);
          } catch {
            fail("CLOUDOS_QA_TESTS_MISSING");
          }
          if (!stat.isDirectory() || stat.isSymbolicLink())
            fail("CLOUDOS_QA_TESTS_UNSAFE");
          return row.path;
        };
        return runner.run({
          ...approvedFullGate,
          project: p.id,
          gate: `command:cloudos_release_qa:full:build@${lane.laneId}#${lane.head}`,
          key: a.requestKey,
          cwd: validate(),
          beforeStart: validate,
        });
      }
      // Dependency setup is a separate opt-in action, not implicit CI logic.
      // The immutable HEAD is derived from the authorized checkout; npm only
      // runs in the existing private SHA-pinned detached lane.
      if (a.command === "main_platform_ui_deps") {
        if (
          a.variant !== "ci" ||
          a.laneId !== undefined ||
          a.expectedHead !== undefined
        )
          fail("COMMAND_NOT_ALLOWED");
        if (p.id !== "kmj-main-platform" || !p.writable)
          fail("READ_ONLY_PROJECT");
        const lane = worktreeLanes().prepareCurrentHead(
          p.id,
          p.files.root,
          "mainplatform_ci",
        );
        const validate = () => {
          const row = worktreeLanes()
            .entries(p.id, p.files.root)
            .find((item) => item.laneId === lane.laneId);
          if (!row || row.head !== lane.head) fail("WORKTREE_HEAD_MISMATCH");
          if (row.dirty) fail("WORKTREE_HAS_UNSAVED_WORK");
          const appRoot = path.join(row.path, "apps", "platform");
          const manifest = path.join(appRoot, "package.json");
          const lockfile = path.join(appRoot, "package-lock.json");
          for (const name of [manifest, lockfile]) {
            let stat;
            try {
              stat = fs.lstatSync(name);
            } catch {
              fail("WORKTREE_DEPS_LOCK_MISSING");
            }
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.size < (name === manifest ? 32 : 128) ||
              stat.size > 2 * 1024 * 1024
            )
              fail("WORKTREE_DEPS_LOCK_UNSAFE");
          }
          let pkg;
          let locked;
          try {
            pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
            locked = JSON.parse(fs.readFileSync(lockfile, "utf8"));
          } catch {
            fail("WORKTREE_DEPS_LOCK_INVALID");
          }
          if (
            pkg.name !== "@kmjtechno/main-platform" ||
            pkg.devDependencies?.["vite-plus"] !== "0.3.0" ||
            locked.lockfileVersion !== 3 ||
            locked.packages?.[""]?.name !== pkg.name ||
            locked.packages?.[""]?.devDependencies?.["vite-plus"] !== "0.3.0" ||
            locked.packages?.["node_modules/vite-plus"]?.version !== "0.3.0"
          )
            fail("WORKTREE_DEPS_LOCK_MISMATCH");
          return row.path;
        };
        const cwd = validate();
        // The agent runner deliberately strips inherited HOME and secrets.
        // npm otherwise falls back to the service user's read-only home
        // (/var/lib/kmjcode/.npm under the hardened systemd sandbox).
        // Put its cache in the already authorized agent-private state root,
        // not the shared checkout or an arbitrary caller-supplied directory.
        const npmCache = path.join(
          laneStateDir,
          "npm-cache",
          createHash("sha256")
            .update(p.id + ":" + lane.head)
            .digest("hex"),
        );
        return runner.run({
          project: p.id,
          gate: `command:main_platform_ui_deps:ci:build@${lane.laneId}#${lane.head}`,
          key: a.requestKey,
          cwd,
          beforeStart: validate,
          command: process.platform === "win32" ? "npm.cmd" : "npm",
          args: [
            "--prefix",
            "apps/platform",
            "--cache",
            npmCache,
            "ci",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--prefer-offline",
          ],
          timeoutMs: 180000,
        });
      }
      // Separate explicit opt-in PHP setup for the SAME SHA-pinned, isolated
      // Main Platform CI lane used by the npm profile. Never use the shared
      // checkout and never accept caller-selected paths, refs or env vars.
      if (a.command === "main_platform_php_deps") {
        if (
          !["ci", "routes"].includes(a.variant) ||
          a.laneId !== undefined ||
          a.expectedHead !== undefined
        )
          fail("COMMAND_NOT_ALLOWED");
        if (p.id !== "kmj-main-platform" || !p.writable)
          fail("READ_ONLY_PROJECT");
        const lane = worktreeLanes().prepareCurrentHead(
          p.id,
          p.files.root,
          "mainplatform_ci",
        );
        const validate = () => {
          const row = worktreeLanes()
            .entries(p.id, p.files.root)
            .find((item) => item.laneId === lane.laneId);
          if (!row || row.head !== lane.head) fail("WORKTREE_HEAD_MISMATCH");
          if (row.dirty) fail("WORKTREE_HAS_UNSAVED_WORK");
          const appRoot = path.join(row.path, "apps", "platform");
          const appStat = fs.lstatSync(appRoot);
          if (!appStat.isDirectory() || appStat.isSymbolicLink())
            fail("WORKTREE_APP_ROOT_UNSAFE");
          const manifest = path.join(appRoot, "composer.json");
          const lockfile = path.join(appRoot, "composer.lock");
          for (const name of [manifest, lockfile]) {
            let stat;
            try {
              stat = fs.lstatSync(name);
            } catch {
              fail("WORKTREE_COMPOSER_LOCK_MISSING");
            }
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.size < (name === manifest ? 128 : 512) ||
              stat.size > 5 * 1024 * 1024
            )
              fail("WORKTREE_COMPOSER_LOCK_UNSAFE");
          }
          let manifestData;
          let lock;
          try {
            manifestData = JSON.parse(fs.readFileSync(manifest, "utf8"));
            lock = JSON.parse(fs.readFileSync(lockfile, "utf8"));
          } catch {
            fail("WORKTREE_COMPOSER_LOCK_INVALID");
          }
          if (
            manifestData.name !== "kmjtechno/kmj-main-platform" ||
            manifestData.require?.["laravel/wayfinder"] === undefined ||
            !/^[a-f0-9]{32}$/.test(lock["content-hash"] ?? "") ||
            !Array.isArray(lock.packages) ||
            !lock.packages.some((pkg) => pkg.name === "laravel/framework") ||
            !lock.packages.some((pkg) => pkg.name === "laravel/wayfinder")
          )
            fail("WORKTREE_COMPOSER_LOCK_MISMATCH");
          if (a.variant === "routes") {
            const autoload = path.join(appRoot, "vendor", "autoload.php");
            let stat;
            try {
              stat = fs.lstatSync(autoload);
            } catch {
              fail("WORKTREE_PHP_VENDOR_NOT_INSTALLED");
            }
            if (!stat.isFile() || stat.isSymbolicLink())
              fail("WORKTREE_PHP_VENDOR_UNSAFE");
          }
          return row.path;
        };
        const cwd = validate();
        return runner.run({
          project: p.id,
          gate: `command:main_platform_php_deps:${a.variant}:build@${lane.laneId}#${lane.head}`,
          key: a.requestKey,
          cwd,
          beforeStart: validate,
          command:
            a.variant === "ci"
              ? process.platform === "win32"
                ? "composer.bat"
                : "composer"
              : "php",
          args:
            a.variant === "ci"
              ? [
                  "--no-cache",
                  "--working-dir",
                  "apps/platform",
                  "install",
                  "--no-interaction",
                  "--no-progress",
                  "--prefer-dist",
                  "--no-plugins",
                  "--no-scripts",
                  "--no-ansi",
                ]
              : [
                  "apps/platform/artisan",
                  "wayfinder:generate",
                  "--with-form",
                  "--no-ansi",
                ],
          timeoutMs: a.variant === "ci" ? 300000 : 120000,
        });
      }
      // Use an already captured client command schema for the same fixed-origin
      // browser job; no arbitrary scripts, paths, URL or terminal execution.
      if (a.command === "browser_public_qa") {
        if (
          a.variant !== "start" ||
          a.laneId !== undefined ||
          a.expectedHead !== undefined
        )
          fail("COMMAND_NOT_ALLOWED");
        if (p.id !== "kmj-main-platform" || !p.writable)
          fail("BROWSER_QA_PROJECT_NOT_ALLOWED");
        if (!laneStateDir) fail("BROWSER_QA_STATE_UNAVAILABLE");
        const script = fileURLToPath(
          new URL("../scripts/browser-public-qa.mjs", import.meta.url),
        );
        if (!fs.existsSync(script)) fail("BROWSER_QA_RUNTIME_NOT_DEPLOYED");
        const receiptKey = createHash("sha256")
          .update(p.id + ":" + a.requestKey)
          .digest("hex");
        return runner.run({
          project: p.id,
          gate: "browser-qa:kmj-public",
          key: a.requestKey,
          cwd: p.files.root,
          command: process.execPath,
          args: [
            script,
            "kmj_public",
            path.join(laneStateDir, "browser-qa", receiptKey),
          ],
          timeoutMs: 120000,
        });
      }
      const profile = (p.commands ?? {})[a.command];
      const variant = profile?.variants?.[a.variant];
      if (!profile || !variant) fail("COMMAND_NOT_ALLOWED");
      if (profile.category !== "inspect" && !p.writable)
        fail("READ_ONLY_PROJECT");
      // Opt-in fixed CI profiles can derive an isolated QA lane from the
      // authorized checkout's exact HEAD. Calibration auto-preparation is
      // restricted to the enrolled Calibration Pro project, never Studio or
      // an unrelated CMake source tree. The caller supplies no ref or path.
      const isPinnedPowerShell = variant.powershellScript !== undefined;
      const autoLanePrefix =
        a.command === "main_platform_ui_ci"
          ? "mainplatform_ci"
          : a.command === "calibration_v4_qa" && p.id === "kmj-calibration-pro"
            ? "calibration_v4_qa"
            : isPinnedPowerShell
              ? "windows_ps_" + a.command.slice(0, 15)
              : null;
      const autoLane =
        autoLanePrefix !== null &&
        a.laneId === undefined &&
        a.expectedHead === undefined
          ? worktreeLanes().prepareCurrentHead(
              p.id,
              p.files.root,
              autoLanePrefix,
            )
          : null;
      const selectedLaneId = autoLane?.laneId ?? a.laneId;
      const selectedHead = autoLane?.head ?? a.expectedHead;
      const pinned =
        commandRequiresIsolatedLane(a.command) ||
        isPinnedPowerShell ||
        selectedHead !== undefined;
      if (pinned && !selectedLaneId) fail("WORKTREE_LANE_REQUIRED");
      if (pinned && !selectedHead) fail("WORKTREE_EXPECTED_HEAD_REQUIRED");
      const verify = () => {
        const lane = worktreeLanes()
          .entries(p.id, p.files.root)
          .find((row) => row.laneId === selectedLaneId);
        if (!lane) fail("WORKTREE_NOT_FOUND");
        if (lane.head !== selectedHead) fail("WORKTREE_HEAD_MISMATCH");
        if (lane.dirty) fail("WORKTREE_HAS_UNSAVED_WORK");
        return lane.path;
      };
      const cwd = pinned ? verify() : laneCwd(selectedLaneId);
      const approvedPowerShell = isPinnedPowerShell
        ? approvedPowerShellInvocation({ cwd, profile, variant })
        : null;
      const beforeStart = () => {
        const verifiedCwd = pinned ? verify() : cwd;
        if (isPinnedPowerShell) {
          // SHA, path and reparse checks are repeated AFTER the queue wait.
          const current = approvedPowerShellInvocation({
            cwd: verifiedCwd,
            profile,
            variant,
          });
          if (
            current.command !== approvedPowerShell.command ||
            JSON.stringify(current.args) !==
              JSON.stringify(approvedPowerShell.args)
          )
            fail("POWERSHELL_SCRIPT_CHANGED_BEFORE_START");
        }
      };
      let gate =
        laneLabel(
          `command:${a.command}:${a.variant}:${profile.category}`,
          selectedLaneId,
        ) + (pinned ? `#${selectedHead}` : "");
      // Keep SHA/lane receipts readable by existing archive readers on rollback.
      if (pinned && gate.length > 128)
        gate = `command@${selectedLaneId}#${selectedHead}`;
      return runner.run({
        project: p.id,
        gate,
        key: a.requestKey,
        cwd,
        ...(pinned || isPinnedPowerShell ? { beforeStart } : {}),
        command: approvedPowerShell?.command ?? profile.command,
        args: approvedPowerShell?.args ?? variant.args,
        timeoutMs: variant.timeoutMs,
      });
    }
    if (name === "browser_agentic_observe") {
      if (p.id !== "kmj-main-platform" || !p.writable)
        fail("BROWSER_AGENTIC_PROJECT_NOT_ALLOWED");
      if (config.browserAgentic?.enabled !== true || !config.browserAgentic.entrySha256)
        fail("BROWSER_AGENTIC_OWNER_OPT_IN_REQUIRED");
      const script = fileURLToPath(
        new URL("../scripts/browser-browsentic-observe.mjs", import.meta.url),
      );
      if (!fs.existsSync(script)) fail("BROWSER_AGENTIC_RUNTIME_NOT_DEPLOYED");
      return runner.run({
        project: p.id,
        gate: "browser-agentic:read-only",
        key: a.requestKey,
        cwd: p.files.root,
        command: process.execPath,
        args: [script, "kmj_owner_browser", config.browserAgentic.entrySha256],
        timeoutMs: 45000,
      });
    }
    if (name === "browser_runtime_status")
      return {
        ...browserRuntimeStatus(),
        agentic: browserAgenticReadiness(config.browserAgentic),
      };
    if (name === "browser_fast_probe") {
      if (p.id !== "kmj-main-platform" || !p.writable)
        fail("BROWSER_QA_PROJECT_NOT_ALLOWED");
      if (!laneStateDir) fail("BROWSER_QA_STATE_UNAVAILABLE");
      const script = fileURLToPath(
        new URL("../scripts/browser-moli-fast.mjs", import.meta.url),
      );
      if (!fs.existsSync(script)) fail("BROWSER_FAST_RUNTIME_NOT_DEPLOYED");
      const receiptKey = createHash("sha256")
        .update(p.id + ":" + a.requestKey)
        .digest("hex");
      return runner.run({
        project: p.id,
        gate: "browser-fast:kmj-public",
        key: a.requestKey,
        cwd: p.files.root,
        command: process.execPath,
        args: [
          script,
          "kmj_public",
          path.join(laneStateDir, "browser-fast", receiptKey),
        ],
        timeoutMs: 180000,
      });
    }
    if (name === "browser_qa_start") {
      if (p.id !== "kmj-main-platform" || !p.writable)
        fail("BROWSER_QA_PROJECT_NOT_ALLOWED");
      if (!laneStateDir) fail("BROWSER_QA_STATE_UNAVAILABLE");
      // This executable is a first-party release file, not caller-provided
      // project code or arbitrary shell. The source is independent of repo
      // modifications; its destination is outside the project checkout.
      const script = fileURLToPath(
        new URL("../scripts/browser-public-qa.mjs", import.meta.url),
      );
      if (!fs.existsSync(script)) fail("BROWSER_QA_RUNTIME_NOT_DEPLOYED");
      const receiptKey = createHash("sha256")
        .update(p.id + ":" + a.requestKey)
        .digest("hex");
      return runner.run({
        project: p.id,
        gate: "browser-qa:kmj-public",
        key: a.requestKey,
        cwd: p.files.root,
        command: process.execPath,
        args: [
          script,
          "kmj_public",
          path.join(laneStateDir, "browser-qa", receiptKey),
        ],
        timeoutMs: 120000,
      });
    }
    if (name === "browser_fast_probe_receipt") {
      if (p.id !== "kmj-main-platform") fail("BROWSER_QA_PROJECT_NOT_ALLOWED");
      const job = runner.get(a.job, p.id);
      if (!job || job.gate !== "browser-fast:kmj-public")
        fail("BROWSER_FAST_JOB_NOT_FOUND");
      if (!["succeeded", "failed"].includes(job.state))
        return { job: a.job, state: job.state, ready: false };
      const internal = runner.jobs.get(a.job) ?? runner.archive.get(a.job);
      if (!laneStateDir || !internal || typeof internal.key !== "string")
        fail("BROWSER_FAST_STATE_UNAVAILABLE");
      const receiptKey = createHash("sha256")
        .update(p.id + ":" + internal.key)
        .digest("hex");
      const directory = path.join(laneStateDir, "browser-fast", receiptKey);
      let proof;
      try {
        proof = verifiedFastReceipt(directory);
      } catch {
        fail("BROWSER_FAST_RECEIPT_INVALID");
      }
      return { job: a.job, state: job.state, ...proof };
    }
    if (name === "browser_qa_receipt") {
      if (p.id !== "kmj-main-platform") fail("BROWSER_QA_PROJECT_NOT_ALLOWED");
      const job = runner.get(a.job, p.id);
      if (!job || job.gate !== "browser-qa:kmj-public")
        fail("BROWSER_QA_JOB_NOT_FOUND");
      if (!["succeeded", "failed"].includes(job.state))
        return { job: a.job, state: job.state, ready: false };
      const internalJob = runner.jobs.get(a.job) ?? runner.archive.get(a.job);
      if (!laneStateDir || !internalJob || typeof internalJob.key !== "string")
        fail("BROWSER_QA_STATE_UNAVAILABLE");
      const receiptKey = createHash("sha256")
        .update(p.id + ":" + internalJob.key)
        .digest("hex");
      const reportPath = path.join(
        laneStateDir,
        "browser-qa",
        receiptKey,
        "receipt.json",
      );
      let data;
      try {
        const stat = fs.lstatSync(reportPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768)
          fail("BROWSER_QA_RECEIPT_INVALID");
        data = JSON.parse(fs.readFileSync(reportPath, "utf8"));
      } catch {
        fail("BROWSER_QA_RECEIPT_NOT_AVAILABLE");
      }
      if (
        data.schema !== "kmj-browser-v1" ||
        data.target !== "kmj_public" ||
        !Array.isArray(data.samples) ||
        data.samples.length > 9
      )
        fail("BROWSER_QA_RECEIPT_INVALID");
      const names = new Set();
      for (const sample of data.samples) {
        if (
          !/^(desktop|tablet|mobile)-(home|products|login)\.png$/.test(
            sample.screenshot ?? "",
          ) ||
          names.has(sample.screenshot) ||
          !/^[a-f0-9]{64}$/.test(sample.sha256 ?? "") ||
          !Number.isInteger(sample.bytes) ||
          sample.bytes < 64 ||
          sample.bytes > 8 * 1024 * 1024
        )
          fail("BROWSER_QA_RECEIPT_INVALID");
        names.add(sample.screenshot);
        const filePath = path.join(path.dirname(reportPath), sample.screenshot);
        let actual;
        try {
          const stat = fs.lstatSync(filePath);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.size !== sample.bytes
          )
            fail("BROWSER_QA_RECEIPT_INVALID");
          actual = createHash("sha256")
            .update(fs.readFileSync(filePath))
            .digest("hex");
        } catch {
          fail("BROWSER_QA_RECEIPT_INVALID");
        }
        if (actual !== sample.sha256) fail("BROWSER_QA_RECEIPT_INVALID");
      }
      if (data.verdict === "PASS" && names.size !== 9)
        fail("BROWSER_QA_RECEIPT_INCOMPLETE");
      return {
        job: a.job,
        state: job.state,
        verdict: data.verdict === "PASS" ? "PASS" : "FAIL",
        reason: /^[A-Z_]{4,80}$/.test(data.reason ?? "") ? data.reason : null,
        sampledAt: data.checkedAt,
        samples: data.samples.map((sample) => ({
          viewport: sample.viewport,
          path: sample.path,
          httpStatus: sample.httpStatus,
          brokenImages: sample.brokenImages,
          overflowPx: sample.overflowPx,
          exceptions: sample.exceptions,
          failures: sample.failures,
          screenshotSha256: sample.sha256,
          screenshotBytes: sample.bytes,
        })),
      };
    }
    if (name === "run_quality_gate") {
      const gate = p.gates[a.gate];
      if (!gate) fail("GATE_NOT_ALLOWED");
      if (!p.writable) fail("READ_ONLY_PROJECT");
      // Capture the approved detached worktree identity before queueing.
      // Revalidate immediately before execution, since another chat may
      // modify the lane while the single permitted job slot is occupied.
      const selected =
        a.laneId === undefined
          ? null
          : worktreeLanes()
              .entries(p.id, p.files.root)
              .find((row) => row.laneId === a.laneId);
      if (a.laneId !== undefined && !selected) fail("WORKTREE_NOT_FOUND");
      const verifyLane = () => {
        const row = worktreeLanes()
          .entries(p.id, p.files.root)
          .find((item) => item.laneId === a.laneId);
        if (!row || row.head !== selected.head || row.path !== selected.path)
          fail("WORKTREE_HEAD_MISMATCH");
        if (row.dirty) fail("WORKTREE_HAS_UNSAVED_WORK");
        return row.path;
      };
      const cwd = selected ? verifyLane() : p.files.root;
      return runner.run({
        project: p.id,
        gate: laneLabel(a.gate, a.laneId),
        key: a.requestKey,
        cwd,
        ...(selected ? { beforeStart: verifyLane } : {}),
        ...gate,
      });
    }
    if (name === "get_job_status") {
      let state = runner.peekState(a.job, p.id);
      // At most MAX_JOB_WAITERS calls wait at once; beyond that the call answers immediately
      // (never an error), so a burst of long waits cannot pile up timers or CPU on the agent.
      if (
        a.waitMs > 0 &&
        ["queued", "running"].includes(state) &&
        jobWaiters < MAX_JOB_WAITERS
      ) {
        jobWaiters += 1;
        try {
          const deadline = Date.now() + a.waitMs;
          while (["queued", "running"].includes(state)) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) break;
            await new Promise((resolve) =>
              setTimeout(resolve, Math.min(250, remaining)),
            );
            state = runner.peekState(a.job, p.id);
          }
        } finally {
          jobWaiters -= 1;
        }
      }
      let job = runner.get(a.job, p.id);
      if (
        a.tailChars !== undefined &&
        typeof job.output === "string" &&
        job.output.length > a.tailChars
      ) {
        job = {
          ...job,
          output: job.output.slice(job.output.length - a.tailChars),
          outputChars: job.output.length,
          outputTailOnly: true,
        };
      }
      if (
        job.gate === "browser-fast:kmj-public" &&
        ["succeeded", "failed"].includes(job.state)
      ) {
        try {
          const receipt = await dispatchCore(
            "browser_fast_probe_receipt",
            { device: a.device, project: p.id, job: a.job },
            permissions,
          );
          job = { ...job, browserFastReceipt: receipt };
        } catch {
          job = {
            ...job,
            browserFastReceipt: {
              verified: false,
              error: "BROWSER_FAST_RECEIPT_INVALID",
            },
          };
        }
      }
      // Preserve browser QA receipt integrity even when an older connected
      // ChatGPT client only captured get_job_status (not browser_qa_receipt).
      // Reuse the exact same project-authorized, hash-verifying read handler.
      // A failed/absent receipt never becomes a false PASS and must not mask
      // the ordinary terminal job status or safe diagnostic output.
      if (
        job.gate === "browser-qa:kmj-public" &&
        ["succeeded", "failed"].includes(job.state)
      ) {
        try {
          const receipt = await dispatchCore(
            "browser_qa_receipt",
            { device: a.device, project: p.id, job: a.job },
            permissions,
          );
          job = {
            ...job,
            browserQaReceipt: { verified: true, ...receipt },
          };
        } catch (error) {
          job = {
            ...job,
            browserQaReceipt: {
              verified: false,
              error: publicError(error).error,
            },
          };
        }
      }
      return job;
    }
    if (name === "cancel_job") return runner.cancel(a.job, p.id);
    fail("UNKNOWN_TOOL");
  };

  return async function dispatch(name, input, permissions) {
    const definition = definitions[name];
    if (
      !audit ||
      !definition ||
      definition.access === "read" ||
      name === "list_devices"
    )
      return dispatchCore(name, input, permissions);

    let a;
    try {
      a = z.object(definition.input).strict().parse(input);
    } catch {
      return dispatchCore(name, input, permissions);
    }
    if (a.device !== config.id || !permissions.includes(definition.access))
      return dispatchCore(name, input, permissions);
    const p = projects.get(a.project);
    if (!p) return dispatchCore(name, input, permissions);

    const risk =
      name === "run_project_command" || name === "ide_run_project_task"
        ? a.command === "cloudos_host_storage_audit"
          ? "READ"
          : [
                "browser_public_qa",
                "main_platform_ui_deps",
                "main_platform_php_deps",
                "cloudos_release_qa",
              ].includes(a.command)
            ? "TEST"
            : commandRisk((p.commands ?? {})[a.command]?.category)
        : toolRisk(name, definition);
    const attempt = audit.append(p.id, {
      device: config.id,
      tool: name,
      access: definition.access,
      risk,
      phase: "attempt",
      outcome: "pending",
    });

    let result;
    try {
      result = await dispatchCore(name, input, permissions);
    } catch (error) {
      audit.append(p.id, {
        device: config.id,
        tool: name,
        access: definition.access,
        risk,
        phase: "result",
        outcome: "failed",
        correlationId: attempt.id,
        error: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
      });
      throw error;
    }

    audit.append(p.id, {
      device: config.id,
      tool: name,
      access: definition.access,
      risk,
      phase: "result",
      outcome: "succeeded",
      correlationId: attempt.id,
    });
    return result;
  };
}
