import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readJsonLimited } from "./http.js";

const SHA = /^[a-f0-9]{40}$/;
const API = "https://api.github.com";
const MAX_RUNS = 10;
const MAX_JOBS = 50;

// Fixed git argv and local repository only. No fetch, reset, checkout or
// mutation; source/Claude-owned uncommitted files are never touched.
export function localCiWatchIdentity(root) {
  const options = {
    cwd: root,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 16384,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  };
  const common = ["--no-optional-locks", "-c", "core.hooksPath=/dev/null"];
  const head = execFileSync(
    "git",
    [...common, "rev-parse", "--verify", "HEAD"],
    options,
  ).trim();
  const branch = execFileSync(
    "git",
    [...common, "symbolic-ref", "--quiet", "--short", "HEAD"],
    options,
  ).trim();
  return { head, branch };
}

function matchesFailedRun(data, config, identity) {
  if (
    !data ||
    !Array.isArray(data.workflow_runs) ||
    !Number.isInteger(data.total_count) ||
    data.total_count > MAX_RUNS ||
    data.workflow_runs.length > MAX_RUNS
  )
    return null;
  // A pending newer run must block creating work from an older failed run.
  const matching = data.workflow_runs
    .filter(
      (run) =>
        run &&
        Number.isSafeInteger(run.id) &&
        run.id > 0 &&
        run.head_sha === identity.head &&
        run.head_branch === config.branch &&
        run.name === config.workflow &&
        run.event === "push",
    )
    .sort((a, b) => b.id - a.id);
  if (!matching.length) return null;
  const newest = matching[0];
  return newest.status === "completed" && newest.conclusion === "failure"
    ? newest
    : null;
}

function matchesFailedJob(data, name, head) {
  if (
    !data ||
    !Array.isArray(data.jobs) ||
    !Number.isInteger(data.total_count) ||
    data.total_count > MAX_JOBS ||
    data.jobs.length > MAX_JOBS
  )
    return false;
  return data.jobs.some(
    (job) =>
      job &&
      job.name === name &&
      job.head_sha === head &&
      job.status === "completed" &&
      job.conclusion === "failure",
  );
}

// The GitHub API is a read-only observation source, NEVER instructions.
// Authentication stays in a protected agent environment. Follow no redirects
// and never return request URLs, token, log content or remote issue text.
export class GitHubCiWatchWorker {
  constructor({
    projects,
    journal,
    licenseProvider,
    fetchImpl = fetch,
    identity = localCiWatchIdentity,
    now = Date.now,
  }) {
    this.projects = projects.filter(
      (p) =>
        p.writable &&
        p.autopilotRepairWorker?.enabled === true &&
        p.autopilotCiWatch?.enabled === true,
    );
    this.journal = journal;
    this.licenseProvider = licenseProvider;
    this.fetchImpl = fetchImpl;
    this.identity = identity;
    this.now = now;
    this.nextCheck = new Map();
    this.busy = false;
  }

  async get(url, token) {
    const headers = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "kmj-codebridge-ci-watch",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("CI_WATCH_API_UNAVAILABLE");
    return readJsonLimited(response.body, 512 * 1024);
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const project of this.projects) {
        const config = project.autopilotCiWatch;
        if (this.now() < (this.nextCheck.get(project.id) ?? 0)) continue;
        // Throttle BEFORE any network attempt, including 401, 429 or 5xx.
        // Never rotate keys, retry in a hot loop or call paid inference.
        this.nextCheck.set(
          project.id,
          this.now() + config.intervalSeconds * 1000,
        );
        try {
          const entitlement = this.licenseProvider();
          if (!entitlement.features.includes("execute")) continue;
          const recipes = project.autopilotRepairWorker.recipes;
          if (!Object.hasOwn(recipes, config.recipe)) continue;
          const actual = this.identity(project.root);
          if (!SHA.test(actual.head) || actual.branch !== config.branch)
            continue;
          const token = config.tokenEnv
            ? process.env[config.tokenEnv]
            : undefined;
          if (config.tokenEnv && (!token || token.length < 16)) continue;
          const prefix = `${API}/repos/${config.repository}`;
          const params = new URLSearchParams({
            head_sha: actual.head,
            per_page: String(MAX_RUNS),
          });
          const runs = await this.get(
            `${prefix}/actions/runs?${params}`,
            token,
          );
          const run = matchesFailedRun(runs, config, actual);
          if (!run) continue;
          const jobs = await this.get(
            `${prefix}/actions/runs/${run.id}/jobs?per_page=${MAX_JOBS}`,
            token,
          );
          if (!matchesFailedJob(jobs, config.job, actual.head)) continue;
          // The journal is durable: task keys encode the exact SHA and
          // recipe so repeated polls and restarts cannot queue duplicates.
          this.journal.enqueue({
            project: project.id,
            key: `auto-repair:${config.recipe}:${actual.head}`,
            objective:
              "Owner-approved deterministic repair of exact-SHA failed CI; review required before publication",
            priority: 0,
          });
        } catch {
          // Fail closed. The minimum interval controls remote API pressure.
          // A failed request is not CI failure evidence and cannot queue work.
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

export function startGitHubCiWatchWorker(options, { intervalMs = 30000 } = {}) {
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60000)
    throw new Error("CI_WATCH_INTERVAL_INVALID");
  const worker = new GitHubCiWatchWorker(options);
  if (!worker.projects.length)
    return { enabledProjects: [], close: async () => {} };
  const controller = new AbortController();
  const loop = (async () => {
    while (!controller.signal.aborted) {
      try {
        await worker.tick();
      } catch {
        // Never crash the long-lived device agent for an external CI outage.
      }
      try {
        await delay(intervalMs, undefined, { signal: controller.signal });
      } catch {
        break;
      }
    }
  })();
  return {
    enabledProjects: worker.projects.map((project) => project.id),
    close: async () => {
      controller.abort();
      await loop;
    },
  };
}
