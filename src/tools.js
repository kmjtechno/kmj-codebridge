import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { identifier } from "./config.js";
import { ProjectFiles } from "./policy.js";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";
import { VERSION } from "./version.js";

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
const scoped = { device: identifier, project: identifier };
const supervisorService = z.enum(["agent", "gateway"]);
const contextBudget = z.enum(["small", "medium", "deep"]);
const fastReadTool = z.enum([
  "inspect_project",
  "connection_doctor",
  "git_status",
  "git_log",
  "list_directory",
  "search_code",
  "autopilot_status",
  "supervisor_status",
  "supervisor_config_validate",
  "supervisor_disk_space",
]);
const file = { ...scoped, path: z.string().min(1).max(1024) };
const patch = {
  ...file,
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
  inspect_project: {
    title: "Inspect project",
    description: "Inspect an authorized project and configured quality gates.",
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
      "Run up to eight allowlisted read-only project checks through one MCP call. Each inner tool keeps its own authorization and strict input validation, and failures are isolated per result.",
    input: {
      ...scoped,
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
  search_code: {
    title: "Search code",
    description:
      "Search literal text in allowed project files with bounded results.",
    input: { ...scoped, query: z.string().min(1).max(200) },
    access: "read",
  },
  read_file: {
    title: "Read file",
    description:
      "Read a bounded UTF-8 project file and its SHA-256 precondition.",
    input: file,
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
    title: "Preview file change",
    description:
      "Validate a proposed file replacement without changing the file.",
    input: patch,
    access: "read",
  },
  write_file: {
    title: "Write file",
    description:
      "Replace an authorized file only when its current hash matches; null hash creates a new file.",
    input: patch,
    access: "write",
  },
  edit_file: {
    title: "Edit file",
    description:
      "Replace one exact, unique text fragment in an authorized file using its current SHA-256 precondition. This reduces payload size for focused code edits.",
    input: {
      ...file,
      oldText: z.string().min(1).max(65536),
      newText: z.string().max(65536),
      expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
    },
    access: "write",
  },
  write_files_atomic: {
    title: "Write files atomically",
    description:
      "Replace or create up to 50 authorized files as one transaction. Every existing file must match its expected SHA-256 or no file is changed.",
    input: {
      ...scoped,
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
      "Claim the highest-priority dependency-ready task without blocking on unrelated waiting work.",
    input: scoped,
    access: "write",
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
  supervisor_update_status: {
    title: "Auto-update status",
    description:
      "Read bounded status for the hardcoded CodeBridge development auto-update service and timer.",
    input: scoped,
    access: "read",
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
      "Run one exact administrator-approved command profile variant through the bounded CodeBridge job runner. No shell, cwd, environment, argv or timeout override is accepted.",
    input: {
      ...scoped,
      command: identifier,
      variant: identifier,
      requestKey: z.string().min(1).max(128),
    },
    access: "execute",
  },
  run_quality_gate: {
    title: "Run quality gate",
    description:
      "Start an administrator-configured command. It can execute project code and change files. Use a stable requestKey for retries.",
    input: {
      ...scoped,
      gate: identifier,
      requestKey: z.string().min(1).max(128),
    },
    access: "execute",
  },
  get_job_status: {
    title: "Get job status",
    description:
      "Read a job result and bounded redacted logs within the authorized project.",
    input: { ...scoped, job: identifier },
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
      "Read connection health and available project capabilities without changing settings.",
    input: scoped,
    access: "read",
  },
};
export function createDispatcher(
  config,
  runner,
  licenseProvider,
  autopilot = null,
  supervisor = null,
) {
  const projects = new Map(
    config.projects.map((p) => [
      p.id,
      { ...p, files: new ProjectFiles(p.root) },
    ]),
  );
  return async function dispatch(name, input, permissions) {
    const definition = definitions[name];
    if (!definition || name === "list_devices") fail("UNKNOWN_TOOL");
    const a = z.object(definition.input).strict().parse(input);
    if (a.device !== config.id || !permissions.includes(definition.access))
      fail("ACCESS_DENIED");
    const p = projects.get(a.project);
    if (!p) fail("PROJECT_NOT_FOUND");
    // Safe status and cancellation remain usable after paid lease expiry.
    if (!["get_job_status", "cancel_job", "autopilot_status"].includes(name)) {
      const entitlement = licenseProvider();
      if (!entitlement.features.includes(definition.access))
        fail("FEATURE_UNAVAILABLE");
      runner.maxConcurrent = entitlement.limits.concurrent_jobs;
    }
    if (name === "inspect_project" || name === "connection_doctor")
      return {
        device: config.id,
        project: p.id,
        writable: p.writable,
        gates: Object.keys(p.gates),
        commands: Object.entries(p.commands).map(([id, profile]) => ({
          id,
          category: profile.category,
          description: profile.description,
          variants: Object.keys(profile.variants),
        })),
        connection: "connected",
        version: VERSION,
      };
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
    if (name === "search_code") {
      const r = p.files.search(a.query);
      return {
        ...r,
        matches: r.matches.map((m) => ({ ...m, text: redact(m.text) })),
      };
    }
    if (name.startsWith("autopilot_") && !autopilot)
      fail("AUTOPILOT_UNAVAILABLE");
    if (name === "autopilot_status") return autopilot.status(p.id, a.limit);
    if (name === "autopilot_enqueue")
      return autopilot.enqueue({
        project: p.id,
        key: a.key,
        objective: a.objective,
        priority: a.priority,
        dependsOn: a.dependsOn,
      });
    if (name === "autopilot_claim") return autopilot.claim(p.id);
    if (name === "autopilot_checkpoint")
      return autopilot.checkpoint(a.task, p.id, {
        summary: a.summary,
        next: a.next,
      });
    if (name === "autopilot_wait")
      return autopilot.wait(a.task, p.id, a.reason);
    if (name === "autopilot_resume") return autopilot.resume(a.task, p.id);
    if (name === "autopilot_complete")
      return autopilot.complete(a.task, p.id, {
        state: a.state,
        result: a.result,
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
    if (name === "supervisor_update_status")
      return await supervisor.request({ op: "update_status" });
    if (name === "supervisor_update_now")
      return await supervisor.request({ op: "update_now" });
    if (name === "supervisor_restart")
      return await supervisor.request({ op: "restart", service: a.service });
    if (name === "preview_file")
      return p.files.preview(a.path, a.content, a.expectedHash);
    if (name === "write_file") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      if (a.expectedHash !== null) {
        const before = p.files.read(a.path);
        if (!preservesSensitiveBindings(before.content, a.content))
          fail("SENSITIVE_CONTENT_PROTECTED");
      }
      return p.files.write(a.path, a.content, a.expectedHash);
    }
    if (name === "edit_file") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
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
      for (const change of a.changes) {
        if (change.expectedHash === null) continue;
        const before = p.files.read(change.path);
        if (!preservesSensitiveBindings(before.content, change.content))
          fail("SENSITIVE_CONTENT_PROTECTED");
      }
      return p.files.writeBatch(a.changes);
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
        commands: Object.entries(p.commands).map(([id, profile]) => ({
          id,
          category: profile.category,
          description: profile.description,
          variants: Object.keys(profile.variants),
        })),
      };
    if (name === "run_project_command") {
      const profile = p.commands[a.command];
      const variant = profile?.variants?.[a.variant];
      if (!profile || !variant) fail("COMMAND_NOT_ALLOWED");
      if (profile.category !== "inspect" && !p.writable)
        fail("READ_ONLY_PROJECT");
      return runner.run({
        project: p.id,
        gate: `command:${a.command}:${a.variant}:${profile.category}`,
        key: a.requestKey,
        cwd: p.files.root,
        command: profile.command,
        args: variant.args,
        timeoutMs: variant.timeoutMs,
      });
    }
    if (name === "run_quality_gate") {
      const gate = p.gates[a.gate];
      if (!gate) fail("GATE_NOT_ALLOWED");
      if (!p.writable) fail("READ_ONLY_PROJECT");
      return runner.run({
        project: p.id,
        gate: a.gate,
        key: a.requestKey,
        cwd: p.files.root,
        ...gate,
      });
    }
    if (name === "get_job_status") return runner.get(a.job, p.id);
    if (name === "cancel_job") return runner.cancel(a.job, p.id);
    fail("UNKNOWN_TOOL");
  };
}
