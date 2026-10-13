import { setTimeout as delay } from "node:timers/promises";

const DRAFT_TASK = /^auto-draft:[A-Za-z0-9._-]{1,100}$/;

// This worker produces review-only, untrusted proposals. It does not apply
// patches, run commands, publish code, mark tasks done or contact cloud APIs.
export class LocalAutopilotDraftWorker {
  constructor({
    projects,
    journal,
    licenseProvider,
    localModel,
    runner = null,
  }) {
    this.projects = projects.filter(
      (p) => p.writable && p.autopilotLocalWorker?.enabled === true,
    );
    this.journal = journal;
    this.licenseProvider = licenseProvider;
    this.localModel = localModel;
    this.runner = runner;
    this.busy = false;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const project of this.projects) {
        try {
          // Check the in-memory queue before touching license state or
          // polling Ollama: idle agents should remain almost zero-I/O.
          if (
            !this.journal.hasReady(project.id, (task) =>
              DRAFT_TASK.test(task.key),
            )
          )
            continue;
          const entitlement = this.licenseProvider();
          if (!entitlement.features.includes("execute")) continue;
          // Do not compete with active project gates or resource pressure.
          const capacity = this.runner?.capacity(project.root);
          if (
            capacity &&
            (capacity.blocked ||
              capacity.constrained ||
              capacity.effectiveMaxConcurrent < 1 ||
              capacity.activeJobs > 0)
          )
            continue;
          const model = project.autopilotLocalWorker.model;
          const client = this.localModel();
          // Do not claim work unless the exact owner-approved local model is
          // installed. A missing Ollama service leaves the task queued.
          const status = await client.status();
          if (
            status.activeRequest ||
            !status.available ||
            !status.models.includes(model)
          )
            continue;

          const claimed = this.journal.claim(project.id, {
            holder: "autopilot-local-worker",
            eligible: (task) => DRAFT_TASK.test(task.key),
          });
          if (!claimed) continue;
          const wait = (reason) =>
            this.journal.wait(
              claimed.id,
              project.id,
              reason,
              claimed.leaseToken,
            );

          try {
            // Crash after persisting checkpoint must never waste inference
            // or falsely mark a proposal as a completed code change.
            if (claimed.checkpoint?.next === "LOCAL_DRAFT_AWAITING_REVIEW") {
              wait("LOCAL_DRAFT_AWAITING_REVIEW");
              continue;
            }
            if (claimed.checkpoint) {
              wait("PREVIOUS_CHECKPOINT_REQUIRES_REVIEW");
              continue;
            }

            const prompt = [
              "KMJ CodeBridge offline engineering draft. Output UNTRUSTED advice only.",
              "Do not claim to have modified files, run tests, or merged code.",
              "Do not request credentials or attempt arbitrary commands.",
              "Produce bounded implementation steps, potential risks and tests.",
              "TASK:",
              claimed.objective.slice(0, 3000),
            ].join("\n");
            const generated = await client.generate({
              model,
              prompt,
              maxTokens: project.autopilotLocalWorker.maxTokens,
              timeoutSeconds: project.autopilotLocalWorker.timeoutSeconds,
            });
            if (!generated.response?.trim()) {
              wait("LOCAL_DRAFT_EMPTY_REVIEW_REQUIRED");
              continue;
            }
            this.journal.checkpoint(claimed.id, project.id, {
              summary: generated.response,
              next: "LOCAL_DRAFT_AWAITING_REVIEW",
              leaseToken: claimed.leaseToken,
            });
            wait(
              generated.hitTokenLimit || generated.truncated
                ? "LOCAL_DRAFT_INCOMPLETE_REVIEW_REQUIRED"
                : "LOCAL_DRAFT_AWAITING_REVIEW",
            );
          } catch {
            // The task must never be silently completed on inference failure.
            // Wait rather than retrying endlessly or escalating to paid cloud.
            try {
              wait("LOCAL_INFERENCE_FAILED_REVIEW_REQUIRED");
            } catch {
              // A lost lease cannot be reclaimed by this worker.
            }
          }
        } catch {
          // Error isolation: one project must not block others.
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

export function startLocalAutopilotDraftWorker(
  options,
  { intervalMs = 30_000 } = {},
) {
  if (
    !Number.isInteger(intervalMs) ||
    intervalMs < 5_000 ||
    intervalMs > 300_000
  )
    throw new Error("LOCAL_AUTOPILOT_INTERVAL_INVALID");
  const worker = new LocalAutopilotDraftWorker(options);
  if (worker.projects.length === 0)
    return { enabledProjects: [], close: async () => {} };
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      await worker.tick();
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
