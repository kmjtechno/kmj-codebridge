import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WorktreeLanes } from "./worktree-lanes.js";

const TASK = /^auto-repair:([A-Za-z0-9_-]{1,40}):([a-f0-9]{40})$/;
const TERMINAL = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
]);
const MAX_PATCH_BYTES = 96 * 1024;

export function parseRepairTask(key, recipes) {
  const m = typeof key === "string" ? TASK.exec(key) : null;
  return m && Object.hasOwn(recipes, m[1])
    ? { recipe: m[1], expectedHead: m[2] }
    : null;
}

function git(root, args, maxBuffer = 131072) {
  return execFileSync(
    "git",
    ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer,
      timeout: 10000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
      },
    },
  );
}

// The approved formatter must only change already-tracked, explicitly
// allowlisted files. Deny newly-created files, deletions, renames, symlinks,
// submodule/binary changes and oversized patches. No checkout is modified here.
export function verifyRepairCandidate(root, allowedPaths) {
  const status = git(root, [
    "status",
    "--porcelain",
    "-z",
    "--untracked-files=all",
  ]);
  if (!status.length || status.length > 32768) return null;
  const records = status.toString("utf8").split("\0").filter(Boolean);
  if (records.length > 20) return null;
  const files = [];
  for (const record of records) {
    const code = record.slice(0, 2);
    const file = record.slice(3);
    if (![" M", "M "].includes(code)) return null;
    if (
      !file ||
      file.startsWith("/") ||
      file.includes("\\") ||
      file
        .split("/")
        .some((segment) => !segment || segment === "." || segment === "..") ||
      !allowedPaths.some((allowed) =>
        allowed.endsWith("/") ? file.startsWith(allowed) : file === allowed,
      )
    )
      return null;
    const location = path.join(root, ...file.split("/"));
    const stat = fs.lstatSync(location);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      return null;
    const mode = git(root, ["ls-files", "--stage", "--", file])
      .toString("utf8")
      .split(" ")[0];
    if (!["100644", "100755"].includes(mode)) return null;
    files.push(file);
  }
  const diff = git(
    root,
    ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"],
    MAX_PATCH_BYTES + 4096,
  );
  if (
    diff.length === 0 ||
    diff.length > MAX_PATCH_BYTES ||
    diff.includes(Buffer.from("GIT binary patch"))
  )
    return null;
  return {
    files,
    bytes: diff.length,
    sha256: createHash("sha256").update(diff).digest("hex"),
  };
}

export class IsolatedRepairWorker {
  constructor({ projects, journal, runner, licenseProvider, lanes }) {
    this.projects = projects.filter(
      (p) => p.writable && p.autopilotRepairWorker?.enabled === true,
    );
    this.journal = journal;
    this.runner = runner;
    this.licenseProvider = licenseProvider;
    this.lanes = lanes;
    this.active = new Map();
  }

  tick() {
    for (const project of this.projects) {
      const existing = this.active.get(project.id);
      if (existing) {
        const job = this.runner.get(existing.jobId, project.id);
        if (!job) continue;
        if (!TERMINAL.has(job.state)) {
          // Gate execution has a hard 300-second command cap, well under the
          // journal's standard 30-minute lease; refresh only near expiry.
          const task = this.journal.get(existing.taskId, project.id);
          if (
            task.lease &&
            Date.parse(task.lease.expiresAt) - Date.now() < 120000
          )
            this.journal.checkpoint(existing.taskId, project.id, {
              summary: "ISOLATED_REPAIR_JOB_RUNNING",
              next: existing.phase,
              leaseToken: existing.leaseToken,
            });
          continue;
        }
        this.active.delete(project.id);
        const wait = (reason) =>
          this.journal.wait(
            existing.taskId,
            project.id,
            reason,
            existing.leaseToken,
          );
        if (job.state !== "succeeded" || job.exitCode !== 0) {
          wait(
            existing.phase === "fix"
              ? "ISOLATED_FIX_FAILED_REVIEW_REQUIRED"
              : "ISOLATED_VERIFY_FAILED_REVIEW_REQUIRED",
          );
          continue;
        }
        const recipe = project.autopilotRepairWorker.recipes[existing.recipe];
        let patch;
        try {
          patch = verifyRepairCandidate(existing.lane, recipe.paths);
        } catch {
          patch = null;
        }
        if (!patch) {
          wait("ISOLATED_REPAIR_UNSAFE_OR_EMPTY_PATCH");
          continue;
        }
        if (existing.phase === "fix") {
          try {
            const gate = project.gates[recipe.verifyGate];
            const verify = this.runner.run({
              project: project.id,
              gate: recipe.verifyGate,
              key: `auto-repair:verify:${existing.taskId}`,
              cwd: existing.lane,
              command: gate.command,
              args: gate.args,
              timeoutMs: gate.timeoutMs,
            });
            this.journal.checkpoint(existing.taskId, project.id, {
              summary: "ISOLATED_PATCH_VERIFY_RUNNING",
              next: "AWAIT_VERIFY_JOB",
              leaseToken: existing.leaseToken,
            });
            this.active.set(project.id, {
              ...existing,
              jobId: verify.id,
              phase: "verify",
            });
          } catch {
            wait("ISOLATED_VERIFY_START_FAILED_REVIEW_REQUIRED");
          }
        } else {
          this.journal.checkpoint(existing.taskId, project.id, {
            summary: JSON.stringify({
              status: "VERIFIED_PATCH_AWAITING_REVIEW",
              laneId: existing.laneId,
              expectedHead: existing.expectedHead,
              files: patch.files,
              patchBytes: patch.bytes,
              patchSha256: patch.sha256,
              verificationJobId: existing.jobId,
              // Don't expose an unbounded patch or silently publish it.
            }),
            next: "VERIFIED_PATCH_AWAITING_REVIEW",
            leaseToken: existing.leaseToken,
          });
          wait("VERIFIED_PATCH_AWAITING_REVIEW");
        }
        continue;
      }

      const recipes = project.autopilotRepairWorker.recipes;
      if (
        !this.journal.hasReady(project.id, (task) =>
          Boolean(parseRepairTask(task.key, recipes)),
        )
      )
        continue;
      try {
        const entitlement = this.licenseProvider();
        if (!entitlement.features.includes("execute")) continue;
        this.runner.maxConcurrent = entitlement.limits.concurrent_jobs;
        const capacity = this.runner.capacity(project.root);
        if (capacity.blocked || capacity.constrained || capacity.activeJobs > 0)
          continue;
      } catch {
        continue;
      }
      const task = this.journal.claim(project.id, {
        holder: "isolated-repair-worker",
        eligible: (candidate) =>
          Boolean(parseRepairTask(candidate.key, recipes)),
      });
      if (!task) continue;
      const pause = (reason) =>
        this.journal.wait(task.id, project.id, reason, task.leaseToken);
      // On restart, never repeat potentially mutating a prior recipe.
      if (task.checkpoint) {
        pause("PREVIOUS_ISOLATED_REPAIR_REQUIRES_REVIEW");
        continue;
      }
      const parsed = parseRepairTask(task.key, recipes);
      const recipe = recipes[parsed.recipe];
      if (
        recipe.fixGate === recipe.verifyGate ||
        !project.gates[recipe.fixGate] ||
        !project.gates[recipe.verifyGate]
      ) {
        pause("ISOLATED_REPAIR_RECIPE_INVALID");
        continue;
      }
      const laneId = "repair_" + task.id.replaceAll("-", "");
      try {
        const lane = this.lanes.prepare(
          project.id,
          project.root,
          laneId,
          parsed.expectedHead,
        );
        if (lane.dirty || lane.reused) {
          pause("ISOLATED_REPAIR_LANE_NOT_FRESH");
          continue;
        }
        // Persist the no-replay fence BEFORE running a mutating recipe.
        this.journal.checkpoint(task.id, project.id, {
          summary: "ISOLATED_REPAIR_PREPARED",
          next: "REPAIR_MUTATION_MAY_HAVE_STARTED",
          leaseToken: task.leaseToken,
        });
        const gate = project.gates[recipe.fixGate];
        const job = this.runner.run({
          project: project.id,
          gate: recipe.fixGate,
          key: `auto-repair:fix:${task.id}`,
          cwd: lane.path,
          command: gate.command,
          args: gate.args,
          timeoutMs: gate.timeoutMs,
        });
        this.active.set(project.id, {
          taskId: task.id,
          leaseToken: task.leaseToken,
          jobId: job.id,
          phase: "fix",
          lane: lane.path,
          laneId,
          recipe: parsed.recipe,
          expectedHead: parsed.expectedHead,
        });
      } catch {
        pause("ISOLATED_REPAIR_START_FAILED_REVIEW_REQUIRED");
      }
    }
  }
}

export function startIsolatedRepairWorker(
  options,
  { intervalMs = 10000 } = {},
) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000)
    throw new Error("AUTOPILOT_REPAIR_INTERVAL_INVALID");
  const worker = new IsolatedRepairWorker(options);
  if (!worker.projects.length)
    return { enabledProjects: [], close: async () => {} };
  const abort = new AbortController();
  const loop = (async () => {
    while (!abort.signal.aborted) {
      try {
        worker.tick();
      } catch {
        // Task state remains available for operator inspection after failure.
      }
      try {
        await delay(intervalMs, undefined, { signal: abort.signal });
      } catch {
        break;
      }
    }
  })();
  return {
    enabledProjects: worker.projects.map((p) => p.id),
    close: async () => {
      abort.abort();
      await loop;
    },
  };
}
