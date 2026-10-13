import { z } from "zod";
import { readJsonLimited } from "./http.js";
import { fail } from "./errors.js";
import { redact } from "./jobs.js";

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const MAX_DIAGNOSTICS = 3;
const MAX_LOG_CHARS = 1024 * 96;
const BAD_SECRET = /(?:\b(?:password|secret|token|api[_-]?key|authorization)\b\s*[=:]\s*|Bearer\s+)[^\s,;]+/gi;
const CI_LINE = /(?:error|fatal|fail(?:ed|ure)?|exception|undefined|cannot|not found|typeerror|syntaxerror|✖|×|E\d{3,5})/i;

export const ciFailureDefinitions = {
  ci_status_failure_log: {
    title: "CircleCI failure diagnostics (read-only)",
    description:
      "Inspect up to three failed steps in one CircleCI job at an exact Git SHA for an explicitly allowlisted repository. Returns bounded redacted error lines, not full logs, signed URLs or credentials. Requires operator-configured server-side CircleCI token and preapproved output hostnames. Never reruns, patches or deploys.",
    input: {
      repository: repoName,
      jobNumber: z.number().int().min(1),
      expectedHeadSha: sha,
    },
    access: "read",
  },
};

function checkedOutputUrl(value, hosts) {
  if (typeof value !== "string" || value.length > 4096) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port && url.port !== "443" ||
    url.hash ||
    !hosts.includes(url.hostname.toLowerCase())
  )
    return null;
  return url;
}

function sanitizedLines(value, max = 18) {
  if (typeof value !== "string") return { lines: [], truncated: false };
  // Strip escape sequences and control characters; never return provider
  // signed URLs, auth headers or credential-like assignments.
  const text = value
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const lines = text.split("\n");
  const matches = [];
  for (const line of lines) {
    const cleaned = redact(line).replace(BAD_SECRET, (match) =>
      match.replace(/(Bearer\\s+|[=:]\\s*)[^\\s,;]+$/i, "$1[REDACTED]"),
    );
    if (!CI_LINE.test(cleaned)) continue;
    // Long error lines can carry tokens, URLs and serialized env data.
    // Avoid copying arbitrary long lines into an MCP response.
    if (cleaned.length > 400) continue;
    if (/https?:\/\/\S+\?\S+/.test(cleaned)) continue;
    matches.push(cleaned.trim());
    if (matches.length >= max) break;
  }
  return {
    lines: matches,
    truncated: lines.length > max || value.length > MAX_LOG_CHARS,
  };
}

export function classifyCiFailure(lines) {
  const text = lines.join(" ");
  if (/phpstan|larastan|property .*does not exist|expects .* given/i.test(text))
    return "PHP_STATIC_ANALYSIS";
  if (/pint|php_cs_fixer|code style|formatting/i.test(text))
    return "PHP_FORMATTING";
  if (/typescript|ts\d{4}|tsc\b|typecheck/i.test(text))
    return "TYPESCRIPT";
  if (/phpunit|assertionfailed|tests: .*failed/i.test(text))
    return "PHP_TEST";
  if (/prettier|eslint|oxlint|oxfmt/i.test(text))
    return "JS_FORMAT_OR_LINT";
  if (/permission denied|unauthorized|403 forbidden/i.test(text))
    return "AUTHORIZATION";
  if (/rate.limit|429|quota exceeded/i.test(text))
    return "RATE_LIMIT";
  return "UNCLASSIFIED";
}

export function createCiFailureReader(config, fetchImpl = fetch) {
  if (!config) return null;
  const token = process.env[config.tokenEnv];
  if (typeof token !== "string" || token.length < 16)
    fail("CIRCLECI_CREDENTIAL_MISSING");
  const allowed = new Set(config.repositories);
  const hosts = config.outputHosts.map((host) => host.toLowerCase());

  return async function readFailure(name, input) {
    if (name !== "ci_status_failure_log") fail("UNKNOWN_TOOL");
    const a = z.object(ciFailureDefinitions[name].input).strict().parse(input);
    if (!allowed.has(a.repository)) fail("CIRCLECI_REPOSITORY_DENIED");
    const [org, repository] = a.repository.split("/");
    const metadataUrl = new URL(
      `https://circleci.com/api/v1.1/project/github/${encodeURIComponent(org)}/${encodeURIComponent(repository)}/${a.jobNumber}`,
    );
    let response;
    try {
      response = await fetchImpl(metadataUrl, {
        method: "GET",
        redirect: "error",
        headers: { "Circle-Token": token, accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      fail("CIRCLECI_METADATA_UNAVAILABLE");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403)
        fail("CIRCLECI_AUTHORIZATION_FAILED");
      if (response.status === 404) fail("CIRCLECI_JOB_NOT_FOUND");
      if (response.status === 429) fail("CIRCLECI_RATE_LIMIT");
      fail("CIRCLECI_METADATA_UNAVAILABLE");
    }
    const job = await readJsonLimited(response.body, 131072);
    if (job.vcs_revision !== a.expectedHeadSha)
      fail("CIRCLECI_HEAD_MISMATCH");
    if (job.build_num !== a.jobNumber || !Array.isArray(job.steps))
      fail("CIRCLECI_METADATA_INVALID");

    const failed = job.steps.flatMap((step, stepIndex) =>
      Array.isArray(step.actions)
        ? step.actions
            .filter(
              (action) =>
                action &&
                (action.status === "failed" ||
                  Number.isInteger(action.exit_code) &&
                    action.exit_code !== 0),
            )
            .map((action) => ({ action, stepIndex, name: step.name }))
        : [],
    );
    const result = [];
    for (const { action, stepIndex, name: stepName } of failed.slice(
      0,
      MAX_DIAGNOSTICS,
    )) {
      const url = checkedOutputUrl(action.output_url, hosts);
      let evidence = "NOT_AVAILABLE";
      let lines = [];
      let truncated = false;
      if (url) {
        try {
          // Presigned URL: NEVER send the API token, NEVER follow a redirect,
          // NEVER expose this URL in the user-visible response.
          const output = await fetchImpl(url, {
            method: "GET",
            redirect: "error",
            signal: AbortSignal.timeout(10000),
          });
          if (output.ok) {
            const blocks = await readJsonLimited(output.body, 98304);
            if (Array.isArray(blocks)) {
              const selected = sanitizedLines(
                blocks
                  .slice(0, 128)
                  .map((part) => part?.message ?? "")
                  .filter((item) => typeof item === "string")
                  .join("\n"),
              );
              lines = selected.lines;
              truncated = selected.truncated;
              evidence = lines.length ? "REDACTED_OUTPUT" : "NO_ERROR_LINES";
            }
          }
        } catch {
          evidence = "OUTPUT_UNAVAILABLE";
        }
      } else if (action.output_url) {
        evidence = "OUTPUT_HOST_NOT_APPROVED";
      }
      result.push({
        step: stepIndex,
        name: redact(String(stepName ?? "")).slice(0, 120),
        exitCode: Number.isInteger(action.exit_code)
          ? action.exit_code
          : null,
        evidence,
        category: classifyCiFailure(lines),
        lines,
        truncated,
      });
    }
    return {
      repository: a.repository,
      jobNumber: a.jobNumber,
      verifiedHeadSha: a.expectedHeadSha,
      result: failed.length ? "FAILED_STEPS" : "NO_FAILED_STEPS_OBSERVED",
      steps: result,
      possiblyMore: failed.length > MAX_DIAGNOSTICS,
      // A fetched failure is diagnostic evidence, not authorization to patch,
      // retry, merge, declare green or change a production environment.
      action: "READ_ONLY_DIAGNOSTIC",
    };
  };
}
