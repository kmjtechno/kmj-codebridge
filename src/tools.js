import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { identifier } from "./config.js";
import { ProjectFiles } from "./policy.js";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";
const scoped = { device: identifier, project: identifier };
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
  inspect_project: {
    title: "Inspect project",
    description: "Inspect an authorized project and configured quality gates.",
    input: scoped,
    access: "read",
  },
  list_directory: {
    title: "List directory",
    description:
      "List up to 500 non-sensitive entries in one directory inside an authorized project.",
    input: { ...scoped, path: z.string().max(1024).default("") },
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
export function createDispatcher(config, runner, licenseProvider) {
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
    if (!["get_job_status", "cancel_job"].includes(name)) {
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
        connection: "connected",
        version: "0.1.0",
      };
    if (name === "list_directory") return p.files.list(a.path);
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
    if (name === "search_code") {
      const r = p.files.search(a.query);
      return {
        ...r,
        matches: r.matches.map((m) => ({ ...m, text: redact(m.text) })),
      };
    }
    if (name === "preview_file")
      return p.files.preview(a.path, a.content, a.expectedHash);
    if (name === "write_file") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      if (a.expectedHash !== null) {
        const before = p.files.read(a.path);
        if (redact(before.content) !== before.content)
          fail("SENSITIVE_CONTENT_PROTECTED");
      }
      return p.files.write(a.path, a.content, a.expectedHash);
    }
    if (name === "edit_file") {
      if (!p.writable) fail("READ_ONLY_PROJECT");
      const before = p.files.read(a.path);
      if (redact(before.content) !== before.content)
        fail("SENSITIVE_CONTENT_PROTECTED");
      return p.files.edit(a.path, a.oldText, a.newText, a.expectedHash);
    }
    if (name === "git_status" || name === "git_diff") {
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
        const args =
          name === "git_diff"
            ? [
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "-c",
                "diff.external=",
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--patch",
                "--",
              ]
            : [
                "--no-optional-locks",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.untrackedCache=false",
                "status",
                "--porcelain=v1",
                "--branch",
                "--untracked-files=normal",
              ];
        const output = execFileSync("git", args, {
            cwd: p.files.root,
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: name === "git_diff" ? 131072 : 32768,
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
        if (name === "git_diff") {
          const bytes = Buffer.from(redacted);
          const truncated = bytes.length > 65536;
          return {
            diff: truncated ? bytes.subarray(0, 65536).toString("utf8") : redacted,
            truncated,
          };
        }
        return { status: redacted };
      } catch {
        fail(name === "git_diff" ? "GIT_DIFF_FAILED" : "GIT_STATUS_FAILED");
      }
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
