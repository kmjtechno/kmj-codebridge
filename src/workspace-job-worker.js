import { execFileSync } from "node:child_process";
import { readJsonLimited } from "./http.js";

// Opt-in consumer for the Main Platform workspace tool queue (contract v1).
// It can only run the three catalogued tools, only for projects an
// administrator enabled locally, and only a gate id the administrator listed
// AND configured. Nothing from the server is ever used as a command, path or URL.
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const CLAIM_TOKEN = /^[0-9a-f]{48}$/;
const GATE_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const JOB_KEYS = [
  "arguments",
  "claim_token",
  "id",
  "lease_expires_at",
  "project_id",
  "tool",
];
export const WORKSPACE_TOOLS = [
  "git_status",
  "inspect_project",
  "quality_gate",
];
const MAX_LEASE_AHEAD_MS = 10 * 60_000;
const REPORT_ATTEMPTS = 6;
const CLAIM_MAX_BYTES = 16384;

const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,80}$/;

// Read-only git facts. No shell, hooks or prompts; only counts leave the device.
export function gitFacts(root, run = execFileSync) {
  const options = {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 262144,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };
  const base = ["--no-optional-locks", "-c", "core.hooksPath=/dev/null"];
  const head = run("git", [...base, "rev-parse", "--verify", "HEAD"], options)
    .trim()
    .toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error("GIT_HEAD_INVALID");
  const lines = run(
    "git",
    [
      ...base,
      "status",
      "--porcelain=v1",
      "--branch",
      "--untracked-files=normal",
    ],
    options,
  )
    .split("\n")
    .filter(Boolean);
  const header = lines.find((line) => line.startsWith("## ")) ?? "";
  const branchRaw = header.slice(3).split("...")[0].split(" ")[0];
  return {
    head,
    branch: SAFE_BRANCH.test(branchRaw) ? branchRaw : "(detached or unnamed)",
    changed: lines.filter((line) => !line.startsWith("## ")).length,
  };
}

export class WorkspaceJobWorker {
  constructor({
    origin,
    credential,
    projects,
    runner,
    licenseProvider,
    fetchImpl = fetch,
    now = Date.now,
    sleep = (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    facts = gitFacts,
    signal,
    onStatus = () => {},
    pollMs = 2000,
    heartbeatMs = 15000,
  }) {
    const url = new URL(origin);
    if (
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new Error("WORKSPACE_JOBS_ORIGIN_INVALID");
    if (typeof credential !== "string" || credential.length < 32)
      throw new Error("WORKSPACE_JOBS_CREDENTIAL_INVALID");
    this.origin = url.origin;
    this.credential = credential;
    this.projects = projects.filter((p) => p.workspaceJobs?.enabled === true);
    this.runner = runner;
    this.licenseProvider = licenseProvider;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.facts = facts;
    this.signal = signal;
    this.onStatus = onStatus;
    this.pollMs = pollMs;
    this.heartbeatMs = heartbeatMs;
    this.nextAt = 0;
    this.failures = 0;
    this.active = null;
  }

  backoff(code, baseMs) {
    this.failures += 1;
    const wait = Math.min(
      baseMs * 2 ** Math.min(this.failures - 1, 6),
      600_000,
    );
    this.nextAt = this.now() + wait;
    this.onStatus(code);
  }

  async request(path, body, extra = {}) {
    const response = await this.fetch(`${this.origin}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${this.credential}`,
        "content-type": "application/json",
        ...extra,
      },
      body: JSON.stringify(body),
      signal: this.signal
        ? AbortSignal.any([this.signal, AbortSignal.timeout(8000)])
        : AbortSignal.timeout(8000),
    });
    let data = null;
    try {
      data = response.body
        ? await readJsonLimited(response.body, CLAIM_MAX_BYTES)
        : null;
    } catch {
      data = null;
    }
    return { status: response.status, data };
  }

  // Never throws and never logs the credential or the claim token.
  async report(job, body) {
    for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt += 1) {
      let result;
      try {
        result = await this.request(
          `/api/codebridge/v1/jobs/${job.id}/events`,
          body,
          { "x-kmj-claim": job.claim },
        );
      } catch {
        result = { status: 0 };
      }
      if (result.status === 200) return { ok: true };
      // 409 cancelled/expired/finished, 401/403 revoked, 404/422: stop immediately.
      if ([401, 403, 404, 409, 413, 422].includes(result.status))
        return { ok: false, stop: true, status: result.status };
      if (this.signal?.aborted) break;
      await this.sleep(Math.min(500 * 2 ** attempt, 8000), this.signal);
    }
    return { ok: false, stop: false };
  }

  validate(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { error: "MALFORMED_JOB" };
    if (typeof raw.id !== "string" || !ULID.test(raw.id))
      return { error: "MALFORMED_JOB" };
    if (
      typeof raw.claim_token !== "string" ||
      !CLAIM_TOKEN.test(raw.claim_token)
    )
      return { error: "MALFORMED_JOB" };
    const keys = Object.keys(raw).sort();
    if (
      keys.length !== JOB_KEYS.length ||
      keys.some((k, i) => k !== JOB_KEYS[i])
    )
      return {
        error: "MALFORMED_JOB",
        job: { id: raw.id, claim: raw.claim_token },
      };
    const job = { id: raw.id, claim: raw.claim_token };
    const project = this.projects.find((p) => p.id === raw.project_id);
    if (!project) return { error: "PROJECT_NOT_ENABLED", job };
    if (!WORKSPACE_TOOLS.includes(raw.tool))
      return { error: "TOOL_NOT_ALLOWED", job };
    if (!project.workspaceJobs.tools.includes(raw.tool))
      return { error: "TOOL_NOT_ENABLED_LOCALLY", job };
    const args = raw.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args))
      return { error: "ARGUMENTS_INVALID", job };
    let gate = null;
    if (raw.tool === "quality_gate") {
      if (
        Object.keys(args).length !== 1 ||
        typeof args.gate !== "string" ||
        !GATE_ID.test(args.gate)
      )
        return { error: "ARGUMENTS_INVALID", job };
      gate = args.gate;
      if (!project.workspaceJobs.gates.includes(gate) || !project.gates?.[gate])
        return { error: "GATE_NOT_ALLOWED", job };
      if (!project.writable) return { error: "READ_ONLY_PROJECT", job };
    } else if (Object.keys(args).length !== 0) {
      return { error: "ARGUMENTS_INVALID", job };
    }
    const lease = Date.parse(raw.lease_expires_at);
    const now = this.now();
    // A lease already over, or absurdly far ahead, means clock drift or a bad server.
    if (
      !Number.isFinite(lease) ||
      lease <= now ||
      lease > now + MAX_LEASE_AHEAD_MS
    )
      return { error: "LEASE_INVALID", job };
    return { job: { ...job, tool: raw.tool, project, gate, lease } };
  }

  async tick() {
    if (this.projects.length === 0 || this.active || this.signal?.aborted)
      return;
    if (this.now() < this.nextAt) return;
    let result;
    try {
      result = await this.request("/api/codebridge/v1/jobs/claim", {});
    } catch {
      return this.backoff("WORKSPACE_JOBS_NETWORK", 5000);
    }
    if (result.status === 503)
      return this.backoff("WORKSPACE_JOBS_DISABLED_BY_SERVER", 60_000);
    if (result.status === 401 || result.status === 403)
      return this.backoff("WORKSPACE_JOBS_CREDENTIAL_REJECTED", 300_000);
    if (result.status !== 200)
      return this.backoff("WORKSPACE_JOBS_CLAIM_FAILED", 10_000);
    this.failures = 0;
    this.nextAt = 0;
    const raw = result.data?.job;
    if (raw === null || raw === undefined) return;
    const checked = this.validate(raw);
    if (checked.error) {
      this.onStatus(checked.error);
      // Without a parseable id + claim token there is nothing safe to report.
      if (checked.job)
        await this.report(checked.job, {
          kind: "failed",
          detail: checked.error,
          summary: `Refused on the device: ${checked.error}`,
        });
      return;
    }
    this.active = checked.job.id;
    try {
      await this.execute(checked.job);
    } finally {
      this.active = null;
    }
  }

  async execute(job) {
    let claims;
    try {
      claims = this.licenseProvider();
    } catch {
      claims = null;
    }
    const feature = job.tool === "quality_gate" ? "execute" : "read";
    // Revalidated on EVERY claim: license state and the local grant for this tool.
    if (
      !claims ||
      !Array.isArray(claims.features) ||
      !claims.features.includes(feature)
    )
      return void (await this.report(job, {
        kind: "failed",
        detail: "LICENSE_NOT_ACTIVE",
        summary: "Refused on the device: the local license is not active.",
      }));
    const started = await this.report(job, { kind: "started" });
    if (!started.ok) return this.onStatus("START_NOT_ACCEPTED");
    try {
      if (job.tool === "quality_gate") return await this.runGate(job);
      return await this.runFacts(job);
    } catch {
      await this.report(job, {
        kind: "failed",
        detail: "DEVICE_ERROR",
        summary: "The device could not complete this request.",
      });
    }
  }

  async runFacts(job) {
    const facts = this.facts(job.project.root);
    const summary =
      job.tool === "git_status"
        ? `Branch ${facts.branch}; ${facts.changed} changed path(s); HEAD ${facts.head.slice(0, 12)}.`
        : `Project ${job.project.id}: HEAD ${facts.head.slice(0, 12)}; ${Object.keys(job.project.gates ?? {}).length} gate(s) configured; ${facts.changed} changed path(s).`;
    await this.report(job, {
      kind: "succeeded",
      detail: "Read-only facts collected.",
      summary,
      evidence: { commit_sha: facts.head, result: "pass" },
    });
  }

  async runGate(job) {
    const root = job.project.root;
    const gate = job.project.gates[job.gate];
    let before = null;
    if (job.project.workspaceJobs.requireCleanCheckout !== false) {
      before = this.facts(root);
      if (before.changed !== 0)
        return void (await this.report(job, {
          kind: "failed",
          detail: "WORKTREE_DIRTY",
          summary:
            "Refused on the device: the checkout has uncommitted changes and this project requires a clean checkout for remote gate runs.",
        }));
    }
    const queued = this.runner.run({
      project: job.project.id,
      gate: job.gate,
      key: `ws-job:${job.id}`,
      cwd: root,
      ...gate,
    });
    const startedAt = this.now();
    let lastBeat = startedAt;
    for (;;) {
      await this.sleep(this.pollMs, this.signal);
      const state = this.runner.get(queued.id, job.project.id);
      if (!["queued", "running"].includes(state.state)) {
        const ok = state.state === "succeeded" && state.exitCode === 0;
        const exit = Number.isInteger(state.exitCode)
          ? Math.min(255, Math.max(0, state.exitCode))
          : undefined;
        await this.report(job, {
          kind: ok ? "succeeded" : "failed",
          detail: ok ? "Gate passed." : `Gate ended: ${state.state}.`,
          summary: `Gate ${job.gate} ${ok ? "passed" : `did not pass (${state.state})`}.`,
          evidence: {
            gate: job.gate,
            result: ok ? "pass" : "fail",
            ...(exit === undefined ? {} : { exit_code: exit }),
            duration_ms: Math.min(
              86_400_000,
              Math.max(0, this.now() - startedAt),
            ),
            ...(before ? { commit_sha: before.head } : {}),
          },
        });
        return;
      }
      if (this.signal?.aborted) {
        this.runner.cancel(queued.id, job.project.id);
        return;
      }
      if (this.now() - lastBeat >= this.heartbeatMs) {
        lastBeat = this.now();
        const beat = await this.report(job, {
          kind: "progress",
          detail: "Gate still running.",
        });
        // Cancelled, expired, revoked or the server is unreachable past our lease: stop the local run.
        if (beat.stop || (!beat.ok && this.now() > job.lease + 120_000)) {
          this.runner.cancel(queued.id, job.project.id);
          this.onStatus("RUN_STOPPED_BY_SERVER_OR_LEASE");
          return;
        }
        if (beat.ok) job.lease = this.now() + 120_000;
      }
    }
  }
}

export function startWorkspaceJobWorker(options, { intervalMs = 10_000 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60_000)
    throw new Error("WORKSPACE_JOBS_INTERVAL_INVALID");
  const enabled = options.projects.filter(
    (p) => p.workspaceJobs?.enabled === true,
  );
  // Default installations create no timer, no request and no background activity.
  if (!options.origin || !options.credential || enabled.length === 0)
    return { enabledProjects: [], isIdle: () => true, close: async () => {} };
  if (process.getuid?.() === 0) throw new Error("WORKSPACE_JOBS_REFUSES_ROOT");
  const controller = new AbortController();
  const worker = new WorkspaceJobWorker({
    ...options,
    signal: controller.signal,
  });
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        if (options.activity) await options.activity.track(() => worker.tick());
        else await worker.tick();
      } catch {
        // Stay alive without leaking details.
      }
      await worker.sleep(intervalMs, controller.signal);
    }
  })();
  return {
    enabledProjects: enabled.map((p) => p.id),
    isIdle: () => worker.active === null,
    close: async () => {
      controller.abort();
      await loop;
    },
  };
}
