import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const GATE_TASK = /^auto-gate:([A-Za-z0-9_-]{1,64}):([a-f0-9]{40})$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

// Queueing an auto-gate task is an execution request, not just a write.
// The caller must hold both the ordinary enqueue (write) permission and
// the execute permission before this opt-in worker can run their task.
export function canQueueAutopilotGate(key, permissions) {
  return (
    typeof key === "string" &&
    Array.isArray(permissions) &&
    ((!key.startsWith("auto-gate:") && !key.startsWith("auto-draft:")) ||
      permissions.includes("execute"))
  );
}

// Only explicit, administrator-allowlisted gate tasks may be executed.
// An unstructured README/roadmap task is NEVER converted into shell commands.
export function parseAutopilotGateTask(key, allowedGates) {
  const match = typeof key === "string" ? GATE_TASK.exec(key) : null;
  return match && allowedGates.includes(match[1])
    ? { gate: match[1], expectedHead: match[2] }
    : null;
}

export function verifyCleanGateCheckout(root, expectedHead) {
  // No shell interpolation, hooks, prompts or optional Git locks.
  const options = {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };
  const args = ["--no-optional-locks", "-c", "core.hooksPath=/dev/null"];
  const head = execFileSync(
    "git",
    [...args, "rev-parse", "--verify", "HEAD"],
    options,
  ).trim();
  if (head !== expectedHead) return false;
  const status = execFileSync(
    "git",
    [...args, "status", "--porcelain", "--untracked-files=all"],
    options,
  ).trim();
  return status === "";
}

export class AutopilotGateWorker {
  constructor({
    projects,
    journal,
    runner,
    licenseProvider,
    checkoutClean = verifyCleanGateCheckout,
    now = Date.now,
  }) {
    this.projects = projects.filter(
      (p) => p.writable && p.autopilotGateWorker?.enabled,
    );
    this.journal = journal;
    this.runner = runner;
    this.licenseProvider = licenseProvider;
    this.checkoutClean = checkoutClean;
    this.now = now;
    this.active = new Map();
  }

  tick() {
    for (const project of this.projects) {
      const current = this.active.get(project.id);
      if (current) {
        const result = this.runner.get(current.jobId, project.id);
        if (result && TERMINAL.has(result.state)) {
          if (result.state === "succeeded" && result.exitCode === 0) {
            this.journal.complete(current.taskId, project.id, {
              state: "succeeded",
              result: "ADMIN_APPROVED_GATE_SUCCEEDED",
              leaseToken: current.leaseToken,
            });
          } else {
            // No unbounded automatic retries or false success.
            this.journal.wait(
              current.taskId,
              project.id,
              "ADMIN_APPROVED_GATE_FAILED_REVIEW_REQUIRED",
              current.leaseToken,
            );
          }
          this.active.delete(project.id);
        } else if (result) {
          // Renew only near lease expiration; no constant journal writes.
          const task = this.journal.get(current.taskId, project.id);
          if (
            task.lease &&
            Date.parse(task.lease.expiresAt) - this.now() < 120_000
          )
            this.journal.checkpoint(current.taskId, project.id, {
              summary: "APPROVED_GATE_RUNNING",
              next: "AWAIT_JOB_RESULT",
              leaseToken: current.leaseToken,
            });
        }
        // One gate at a time per project; no duplicate execution.
        continue;
      }

      const allowed = project.autopilotGateWorker.gates;
      if (
        !this.journal.hasReady(project.id, (task) =>
          Boolean(parseAutopilotGateTask(task.key, allowed)),
        )
      )
        continue;
      let entitlement;
      try {
        entitlement = this.licenseProvider();
        if (!entitlement.features.includes("execute")) continue;
        this.runner.maxConcurrent = entitlement.limits.concurrent_jobs;
        if (this.runner.capacity(project.root).blocked) continue;
      } catch {
        continue; // fail closed on expired license or low resources
      }

      const claimed = this.journal.claim(project.id, {
        holder: "autopilot-gate-worker",
        eligible: (task) => Boolean(parseAutopilotGateTask(task.key, allowed)),
      });
      if (!claimed) continue;
      const spec = parseAutopilotGateTask(claimed.key, allowed);
      const gate = project.gates[spec.gate];
      const pause = (reason) =>
        this.journal.wait(claimed.id, project.id, reason, claimed.leaseToken);

      if (!gate) {
        pause("APPROVED_GATE_NOT_CONFIGURED");
        continue;
      }

      try {
        if (!this.checkoutClean(project.root, spec.expectedHead)) {
          pause("GIT_HEAD_CHANGED_OR_WORKTREE_DIRTY");
          continue;
        }
        const job = this.runner.run({
          project: project.id,
          gate: spec.gate,
          key: `auto-gate:${claimed.id}`,
          cwd: project.root,
          command: gate.command,
          args: gate.args,
          timeoutMs: gate.timeoutMs,
        });
        this.journal.checkpoint(claimed.id, project.id, {
          summary: "APPROVED_GATE_DISPATCHED",
          next: "AWAIT_JOB_RESULT",
          leaseToken: claimed.leaseToken,
        });
        this.active.set(project.id, {
          taskId: claimed.id,
          jobId: job.id,
          leaseToken: claimed.leaseToken,
        });
      } catch {
        // No retry storm; an owner can inspect and explicitly resume.
        pause("APPROVED_GATE_START_FAILED_REVIEW_REQUIRED");
      }
    }
  }
}

// A real on-device bounded worker loop. Disabled by default unless explicitly
// enabled by the administrator for an approved project's known gate ids.
export function startAutopilotGateWorker(
  options,
  { intervalMs = 10_000 } = {},
) {
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 1_000 ||
    intervalMs > 60_000
  )
    throw new Error("AUTOPILOT_GATE_INTERVAL_INVALID");
  const worker = new AutopilotGateWorker(options);
  // Default installations create no worker timer or extra background activity.
  if (worker.projects.length === 0)
    return { enabledProjects: [], close: async () => {} };
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        worker.tick();
      } catch {
        // Stay alive without leaking task details or making unsafe guesses.
      }
      try {
        await delay(intervalMs, undefined, { signal: controller.signal });
      } catch {
        break;
      }
    }
  })();
  return {
    enabledProjects: worker.projects.map((p) => p.id),
    close: async () => {
      controller.abort();
      await loop;
    },
  };
}
