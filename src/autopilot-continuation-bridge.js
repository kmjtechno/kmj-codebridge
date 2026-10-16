import { AgentCoordination } from "./agent-coordination.js";

// A local, bounded outbox for an already-authorized project's Autopilot
// journal. It does not start ChatGPT, invoke an LLM or execute a command.
// Durable coordination messages are pull-readable by the next connected chat.
// Existing opt-in workers independently execute only configured safe recipes.
const PROJECT = /^[A-Za-z0-9_-]{1,64}$/;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const MAX_HISTORY = 50;

export function continuationReceipts(journal, project) {
  if (!PROJECT.test(project)) throw new Error("CONTINUATION_PROJECT_INVALID");
  const snapshot = journal.status(project, MAX_HISTORY);
  const records = [];
  for (const task of snapshot.tasks) {
    if (!/^[a-f0-9-]{36}$/.test(task.id ?? "")) continue;
    if (TERMINAL.has(task.state)) {
      records.push({
        key: "done-" + task.id,
        kind: "result",
        // Do not repeat the objective, result, checkpoint, lease, hashes,
        // secrets or model output into the shared coordination mailbox.
        note: "Task " + task.id + " recorded " + task.state +
          ". Evidence and release gates require independent verification.",
      });
    } else if (task.state === "waiting") {
      records.push({
        key: "blocked-" + task.id,
        kind: "handoff",
        note: "Task " + task.id +
          " is waiting. Continue another dependency-ready approved task.",
      });
    }
  }
  if (snapshot.next && /^[a-f0-9-]{36}$/.test(snapshot.next.id)) {
    records.push({
      key: "next-" + snapshot.next.id,
      kind: "handoff",
      note: "Next ready task " + snapshot.next.id +
        ". Claim through CodeBridge with a lease; execute only approved steps.",
    });
  }
  return records;
}

export class AutopilotContinuationBridge {
  constructor({ journal, stateDir, projects, coordination = null }) {
    if (!journal || typeof journal.subscribe !== "function")
      throw new Error("CONTINUATION_JOURNAL_REQUIRED");
    if (!Array.isArray(projects) || projects.some((id) => !PROJECT.test(id)))
      throw new Error("CONTINUATION_PROJECT_INVALID");
    this.journal = journal;
    this.projects = [...new Set(projects)];
    this.coordination = coordination ?? new AgentCoordination(stateDir);
    this.delivered = new Set();
    this.lastError = null;
    this.deliveredCount = 0;
    this.closed = false;
    this.scheduled = false;
    this.unsubscribe = journal.subscribe(() => this.schedule());
    // Reconcile after restarts; immutable request keys deduplicate messages
    // that were successfully committed before a crash.
    this.schedule();
  }

  schedule() {
    if (this.closed || this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      if (this.closed) return;
      this.flush();
    });
  }

  flush() {
    for (const project of this.projects) {
      try {
        const receipts = continuationReceipts(this.journal, project);
        for (const record of receipts) {
          const seenKey = project + ":" + record.key;
          if (this.delivered.has(seenKey)) continue;
          // The immutable mailbox holds a single receipt for each task/state.
          // Only journal-derived, bounded identifiers are included.
          this.coordination.post(project, {
            actor: "codebridge-autopilot",
            recipient: "all",
            requestKey: record.key,
            kind: record.kind,
            note: record.note,
            reportedGate: "unknown",
          });
          this.delivered.add(seenKey);
          this.deliveredCount++;
          this.lastError = null;
        }
      } catch (error) {
        // The journal transaction succeeded already. Never roll it back,
        // retry in a tight loop or claim the chat was notified.
        this.lastError =
          error?.code === "COORDINATION_CAPACITY_REACHED"
            ? "COORDINATION_CAPACITY_REACHED"
            : "COORDINATION_HANDOFF_FAILED";
      }
    }
  }

  status(project) {
    if (!this.projects.includes(project))
      throw new Error("CONTINUATION_PROJECT_INVALID");
    return {
      project,
      installed: !this.closed,
      source: "DURABLE_PROJECT_JOURNAL",
      deliveredThisProcess: this.deliveredCount,
      lastError: this.lastError,
      automaticChatWake: false,
      backgroundInference: false,
      note: "Only pre-approved device workers run unattended. Authorized chats must pull coordination_list; no ChatGPT conversation is auto-started.",
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
  }
}

export function startAutopilotContinuationBridge(options) {
  return new AutopilotContinuationBridge(options);
}
