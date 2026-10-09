import { z } from "zod";
import { readJsonLimited, readTextLimited } from "./http.js";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";
import { VERSION } from "./version.js";

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const branchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._\/-]+$/);
const commitSha = z.string().regex(/^[a-f0-9]{40}$/i);
const contentPath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      !/[\x00-\x1f]/.test(value) &&
      value.split("/").every((part) => part && part !== "." && part !== ".."),
  );
const issueNumber = z.number().int().min(1);
const runId = z.number().int().min(1);

export const githubDefinitions = {
  github_pull_requests: {
    title: "List GitHub pull requests",
    description:
      "Read a bounded open/closed PR queue with exact head SHA, draft state and review context for an allowlisted repository.",
    input: {
      repository: repoName,
      state: z.enum(["open", "closed", "all"]).default("open"),
      limit: z.number().int().min(1).max(30).default(20),
    },
    access: "read",
  },
  github_pull_request_ci: {
    title: "PR head GitHub CI evidence",
    description:
      "Read check runs and workflow runs for the exact current PR head in one operation. Pending, missing and truncated evidence is never described as green.",
    input: { repository: repoName, number: issueNumber },
    access: "read",
  },
  github_issue: {
    title: "Read GitHub issue",
    description:
      "Read an allowed repository issue with bounded text, labels and state.",
    input: { repository: repoName, number: issueNumber },
    access: "read",
  },
  github_issue_comments: {
    title: "Read GitHub issue comments",
    description:
      "Read a bounded first page of issue or PR conversation comments, without exposing GitHub credentials.",
    input: {
      repository: repoName,
      number: issueNumber,
      limit: z.number().int().min(1).max(30).default(20),
    },
    access: "read",
  },
  github_create_issue: {
    title: "Create GitHub issue",
    description:
      "Open one issue in an allowlisted repository, using the centrally held GitHub credential.",
    input: {
      repository: repoName,
      title: z.string().min(1).max(256),
      body: z.string().max(12000).default(""),
    },
    access: "write",
  },
  github_comment_issue: {
    title: "Comment on GitHub issue or PR",
    description:
      "Post a bounded comment to an allowlisted issue or pull request; no arbitrary GitHub API access.",
    input: {
      repository: repoName,
      number: issueNumber,
      body: z.string().min(1).max(12000),
    },
    access: "write",
  },
  github_create_file: {
    title: "Create file in a GitHub feature branch",
    description:
      "Create a new UTF-8 file only on an existing non-default feature branch in an allowlisted repository, never overwrite an existing blob.",
    input: {
      repository: repoName,
      path: contentPath,
      branch: branchName,
      content: z.string().max(262144),
      message: z.string().min(1).max(256),
    },
    access: "write",
  },
  github_repository: {
    title: "GitHub repository",
    description:
      "Read metadata for one configured GitHub repository through the server-side GitHub bridge.",
    input: { repository: repoName },
    access: "read",
  },
  github_pull_request: {
    title: "GitHub pull request",
    description:
      "Read one pull request and its bounded metadata from an allowed repository.",
    input: { repository: repoName, number: issueNumber },
    access: "read",
  },
  github_pull_request_files: {
    title: "GitHub pull request files",
    description:
      "Read up to 100 changed files for one pull request without exposing server credentials.",
    input: { repository: repoName, number: issueNumber },
    access: "read",
  },
  github_actions_runs: {
    title: "GitHub Actions runs",
    description:
      "Read recent Actions workflow runs for an allowed repository and optional branch.",
    input: {
      repository: repoName,
      branch: branchName.optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
    access: "read",
  },
  github_actions_run_jobs: {
    title: "GitHub Actions run jobs",
    description:
      "Read jobs and conclusions for one Actions workflow run in an allowed repository.",
    input: { repository: repoName, runId },
    access: "read",
  },
  github_actions_job_log: {
    title: "GitHub Actions job log",
    description:
      "Read a bounded redacted log for one GitHub Actions job in an allowed repository.",
    input: {
      repository: repoName,
      jobId: runId,
    },
    access: "read",
  },
  github_create_branch: {
    title: "Create GitHub branch",
    description:
      "Create a branch from an exact commit SHA in an allowed repository using the server-side GitHub credential.",
    input: {
      repository: repoName,
      branch: branchName,
      sha: commitSha,
    },
    access: "write",
  },
  github_update_file: {
    title: "Update GitHub file",
    description:
      "Replace one existing repository file on an exact branch and blob SHA. The server credential remains private and stale writes fail closed.",
    input: {
      repository: repoName,
      path: contentPath,
      branch: branchName,
      sha: commitSha,
      content: z.string().max(262144),
      message: z.string().min(1).max(256),
    },
    access: "write",
  },
  github_create_pull_request: {
    title: "Create GitHub pull request",
    description:
      "Create a pull request in an allowed repository. The server credential remains private.",
    input: {
      repository: repoName,
      title: z.string().min(1).max(256),
      body: z.string().max(20000).default(""),
      head: branchName,
      base: branchName.default("main"),
      draft: z.boolean().default(false),
    },
    access: "write",
  },
  github_merge_pull_request: {
    title: "Merge green GitHub pull request",
    description:
      "Merge only an exact pull-request head after all GitHub check runs for that head are completed and successful.",
    input: {
      repository: repoName,
      number: issueNumber,
      expectedHeadSha: commitSha,
      method: z.enum(["squash", "merge", "rebase"]).default("squash"),
    },
    access: "write",
  },
};

function safePath(repository) {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function safeContentPath(value) {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function bounded(value, max = 65536) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const redacted = redact(text);
  const bytes = Buffer.from(redacted);
  return {
    text:
      bytes.length > max ? bytes.subarray(0, max).toString("utf8") : redacted,
    truncated: bytes.length > max,
  };
}

export function createGitHubBridge(config) {
  if (!config) return null;
  const publicReadOnly = config.publicReadOnly === true;
  const token = config.tokenEnv ? process.env[config.tokenEnv] : undefined;
  if (!publicReadOnly && (typeof token !== "string" || token.length < 20))
    fail("GITHUB_CREDENTIAL_MISSING");
  if (
    publicReadOnly &&
    new URL(config.apiBase).href !== "https://api.github.com/"
  )
    fail("GITHUB_ENDPOINT_INVALID");

  const allowed = new Set(config.repositories);
  const cache = new Map();

  const verifyRepo = (repository) => {
    if (!allowed.has(repository)) fail("GITHUB_REPOSITORY_DENIED");
  };

  const request = async (method, repository, suffix, body, cacheKey) => {
    verifyRepo(repository);
    const key = cacheKey ? `${repository}:${cacheKey}` : null;
    const cached = key ? cache.get(key) : null;
    if (cached && Date.now() - cached.at < config.cacheSeconds * 1000)
      return cached.value;

    const base = new URL(config.apiBase);
    const url = new URL(
      `repos/${safePath(repository)}/${suffix.replace(/^\//, "")}`,
      base,
    );
    if (url.origin !== base.origin) fail("GITHUB_ENDPOINT_INVALID");

    if (publicReadOnly && method !== "GET") fail("GITHUB_WRITE_DISABLED");
    const headers = {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": `KMJ-CodeBridge/${VERSION}`,
      "x-github-api-version": "2022-11-28",
    };
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await fetch(url, {
      method,
      redirect: "error",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        fail("GITHUB_AUTHORIZATION_FAILED");
      if (response.status === 404) fail("GITHUB_NOT_FOUND");
      if (response.status === 409 || response.status === 422)
        fail("GITHUB_CONFLICT");
      if (response.status === 429) fail("GITHUB_RATE_LIMIT");
      fail("GITHUB_REQUEST_FAILED");
    }

    const value = await readJsonLimited(response.body, 262144);
    if (key) cache.set(key, { at: Date.now(), value });
    else cache.clear();
    return value;
  };

  const raw = async (repository, suffix) => {
    verifyRepo(repository);
    const base = new URL(config.apiBase);
    const url = new URL(
      `repos/${safePath(repository)}/${suffix.replace(/^\//, "")}`,
      base,
    );
    const headers = {
      accept: "application/vnd.github+json",
      "user-agent": `KMJ-CodeBridge/${VERSION}`,
      "x-github-api-version": "2022-11-28",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) fail("GITHUB_REQUEST_FAILED");
    const text = await readTextLimited(response.body, 65536);
    return bounded(text, 65536);
  };

  return async function dispatch(name, input) {
    const definition = githubDefinitions[name];
    if (!definition) fail("UNKNOWN_TOOL");
    const a = z.object(definition.input).strict().parse(input);

    if (name === "github_pull_requests") {
      const params = new URLSearchParams({
        state: a.state,
        per_page: String(a.limit),
      });
      const data = await request(
        "GET",
        a.repository,
        `pulls?${params}`,
        undefined,
        `pull-list:${params}`,
      );
      if (!Array.isArray(data)) fail("GITHUB_RESPONSE_INVALID");
      return {
        state: a.state,
        pullRequests: data.slice(0, a.limit).map((pull) => ({
          number: pull.number,
          title: bounded(pull.title ?? "", 512).text,
          state: pull.state,
          draft: pull.draft === true,
          head: pull.head?.sha ?? null,
          head_ref: pull.head?.ref ?? null,
          base_ref: pull.base?.ref ?? null,
          updated_at: pull.updated_at ?? null,
          url: pull.html_url ?? null,
        })),
        possiblyMore: data.length >= a.limit,
      };
    }

    if (name === "github_pull_request_ci") {
      // Always bind both CI queries to the PR's current, exact head.
      const pull = await request(
        "GET",
        a.repository,
        `pulls/${a.number}`,
      );
      const head = pull.head?.sha;
      if (typeof head !== "string" || !/^[a-f0-9]{40}$/i.test(head))
        fail("GITHUB_RESPONSE_INVALID");
      const [checkResult, workflowResult] = await Promise.all([
        request(
          "GET",
          a.repository,
          `commits/${head}/check-runs?per_page=100`,
        ),
        request(
          "GET",
          a.repository,
          `actions/runs?head_sha=${head}&per_page=100`,
        ),
      ]);
      const checks = checkResult.check_runs;
      const runs = workflowResult.workflow_runs;
      if (!Array.isArray(checks) || !Array.isArray(runs))
        fail("GITHUB_RESPONSE_INVALID");
      const checksComplete =
        Number.isInteger(checkResult.total_count) &&
        checkResult.total_count > 0 &&
        checkResult.total_count <= 100 &&
        checks.length === checkResult.total_count;
      const workflowsComplete =
        Number.isInteger(workflowResult.total_count) &&
        workflowResult.total_count > 0 &&
        workflowResult.total_count <= 100 &&
        runs.length === workflowResult.total_count &&
        runs.every((run) => run.head_sha === head);
      const pending = [...checks, ...runs].some(
        (entry) => entry.status !== "completed",
      );
      const failed = [...checks, ...runs].some(
        (entry) =>
          entry.status === "completed" && entry.conclusion !== "success",
      );
      const fullyObserved = checksComplete && workflowsComplete;
      const verdict = !fullyObserved
        ? "unverified"
        : pending
          ? "pending"
          : failed
            ? "failed"
            : "green";
      return {
        number: a.number,
        head,
        state: pull.state,
        draft: pull.draft === true,
        verdict,
        verifiedComplete: verdict === "green",
        evidenceComplete: fullyObserved,
        checks: checks.slice(0, 100).map((check) => ({
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
        })),
        workflows: runs.slice(0, 100).map((run) => ({
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          head_sha: run.head_sha,
        })),
        limits: {
          checkTotal: checkResult.total_count ?? null,
          workflowTotal: workflowResult.total_count ?? null,
        },
      };
    }

    if (name === "github_issue") {
      const issue = await request(
        "GET",
        a.repository,
        `issues/${a.number}`,
        undefined,
        `issue:${a.number}`,
      );
      return {
        number: issue.number,
        title: bounded(issue.title ?? "", 512).text,
        body: bounded(issue.body ?? "", 8000),
        state: issue.state,
        labels: (issue.labels ?? []).slice(0, 30).map((label) => label.name),
        updated_at: issue.updated_at,
        url: issue.html_url,
        isPullRequest: Boolean(issue.pull_request),
      };
    }

    if (name === "github_issue_comments") {
      const comments = await request(
        "GET",
        a.repository,
        `issues/${a.number}/comments?per_page=${a.limit}`,
        undefined,
        `comments:${a.number}:${a.limit}`,
      );
      if (!Array.isArray(comments)) fail("GITHUB_RESPONSE_INVALID");
      return {
        number: a.number,
        comments: comments.slice(0, a.limit).map((comment) => ({
          id: comment.id,
          author: comment.user?.login ?? null,
          body: bounded(comment.body ?? "", 6000),
          created_at: comment.created_at,
        })),
        possiblyMore: comments.length >= a.limit,
      };
    }

    if (name === "github_create_issue") {
      const issue = await request("POST", a.repository, "issues", {
        title: a.title,
        body: a.body,
      });
      return { number: issue.number, state: issue.state, url: issue.html_url };
    }

    if (name === "github_comment_issue") {
      const comment = await request(
        "POST",
        a.repository,
        `issues/${a.number}/comments`,
        { body: a.body },
      );
      return { id: comment.id, url: comment.html_url };
    }

    if (name === "github_create_file") {
      // Never permit an arbitrary single-step write to a protected default
      // branch. Existing file overwrites fail at GitHub without a blob SHA.
      const metadata = await request("GET", a.repository, "");
      if (typeof metadata.default_branch !== "string" ||
          !branchName.safeParse(metadata.default_branch).success)
        fail("GITHUB_DEFAULT_BRANCH_UNVERIFIED");
      if (a.branch === metadata.default_branch)
        fail("GITHUB_DEFAULT_BRANCH_WRITE_DENIED");
      const result = await request(
        "PUT",
        a.repository,
        `contents/${safeContentPath(a.path)}`,
        {
          message: a.message,
          content: Buffer.from(a.content, "utf8").toString("base64"),
          branch: a.branch,
        },
      );
      return {
        path: result.content?.path,
        content_sha: result.content?.sha,
        commit_sha: result.commit?.sha,
      };
    }

    if (name === "github_repository") {
      const data = await request("GET", a.repository, "", undefined, "repo");
      return {
        repository: data.full_name,
        default_branch: data.default_branch,
        private: data.private,
        archived: data.archived,
        visibility: data.visibility,
        updated_at: data.updated_at,
      };
    }

    if (name === "github_pull_request") {
      const data = await request(
        "GET",
        a.repository,
        `pulls/${a.number}`,
        undefined,
        `pr:${a.number}`,
      );
      return {
        number: data.number,
        title: data.title,
        state: data.state,
        draft: data.draft,
        mergeable: data.mergeable,
        head: data.head?.sha,
        head_ref: data.head?.ref,
        base: data.base?.sha,
        base_ref: data.base?.ref,
        changed_files: data.changed_files,
        additions: data.additions,
        deletions: data.deletions,
        updated_at: data.updated_at,
      };
    }

    if (name === "github_pull_request_files") {
      const data = await request(
        "GET",
        a.repository,
        `pulls/${a.number}/files?per_page=100`,
        undefined,
        `pr-files:${a.number}`,
      );
      return {
        files: data.slice(0, 100).map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: bounded(file.patch ?? "", 12000).text,
        })),
        truncated: data.length > 100,
      };
    }

    if (name === "github_actions_runs") {
      const params = new URLSearchParams({
        per_page: String(a.limit),
      });
      if (a.branch) params.set("branch", a.branch);
      const data = await request(
        "GET",
        a.repository,
        `actions/runs?${params}`,
        undefined,
        `runs:${params}`,
      );
      return {
        runs: (data.workflow_runs ?? []).slice(0, a.limit).map((run) => ({
          id: run.id,
          name: run.name,
          status: run.status,
          conclusion: run.conclusion,
          head_sha: run.head_sha,
          head_branch: run.head_branch,
          event: run.event,
          created_at: run.created_at,
          updated_at: run.updated_at,
        })),
      };
    }

    if (name === "github_actions_run_jobs") {
      const data = await request(
        "GET",
        a.repository,
        `actions/runs/${a.runId}/jobs?per_page=100`,
        undefined,
        `jobs:${a.runId}`,
      );
      return {
        jobs: (data.jobs ?? []).slice(0, 100).map((job) => ({
          id: job.id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          started_at: job.started_at,
          completed_at: job.completed_at,
        })),
      };
    }

    if (name === "github_actions_job_log")
      return raw(a.repository, `actions/jobs/${a.jobId}/logs`);

    if (name === "github_create_branch") {
      const data = await request("POST", a.repository, "git/refs", {
        ref: `refs/heads/${a.branch}`,
        sha: a.sha,
      });
      return { ref: data.ref, sha: data.object?.sha };
    }

    if (name === "github_update_file") {
      const data = await request(
        "PUT",
        a.repository,
        `contents/${safeContentPath(a.path)}`,
        {
          message: a.message,
          content: Buffer.from(a.content, "utf8").toString("base64"),
          sha: a.sha,
          branch: a.branch,
        },
      );
      return {
        path: data.content?.path,
        content_sha: data.content?.sha,
        commit_sha: data.commit?.sha,
      };
    }

    if (name === "github_create_pull_request") {
      const data = await request("POST", a.repository, "pulls", {
        title: a.title,
        body: a.body,
        head: a.head,
        base: a.base,
        draft: a.draft,
      });
      return {
        number: data.number,
        title: data.title,
        state: data.state,
        head: data.head?.sha,
        base: data.base?.sha,
        url: data.html_url,
      };
    }

    if (name === "github_merge_pull_request") {
      const pull = await request(
        "GET",
        a.repository,
        `pulls/${a.number}`,
        undefined,
      );
      if (pull.state !== "open") fail("GITHUB_PULL_REQUEST_NOT_OPEN");
      if (pull.head?.sha !== a.expectedHeadSha) fail("GITHUB_HEAD_MOVED");

      const checks = await request(
        "GET",
        a.repository,
        `commits/${a.expectedHeadSha}/check-runs?per_page=100`,
        undefined,
      );
      const runs = checks.check_runs ?? [];
      if (
        !Number.isInteger(checks.total_count) ||
        checks.total_count < 1 ||
        checks.total_count > 100 ||
        runs.length !== checks.total_count ||
        runs.some(
          (run) => run.status !== "completed" || run.conclusion !== "success",
        )
      )
        fail("GITHUB_CHECKS_NOT_GREEN");

      const data = await request(
        "PUT",
        a.repository,
        `pulls/${a.number}/merge`,
        {
          sha: a.expectedHeadSha,
          merge_method: a.method,
        },
      );
      return {
        merged: data.merged === true,
        sha: data.sha ?? null,
        message: bounded(data.message ?? "", 1024).text,
      };
    }

    fail("UNKNOWN_TOOL");
  };
}
