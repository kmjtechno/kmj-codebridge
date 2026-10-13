// Advisory "free-first" audit of a project's CI configuration.
//
// It reads workflow text only: it never executes anything, never contacts a provider and never
// sees secret values (workflow files hold secret NAMES, not values). It cannot know the account's
// billing plan or whether a repository is private, so every finding is advice with the condition
// spelled out, never a claim about an invoice. All alternatives are legal, free-tier-or-own-
// hardware options; none relies on evading a provider's limits or terms.

const SEVERITIES = ["high", "medium", "low", "info"];

const PAID_CREDENTIAL =
  /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|AZURE_OPENAI\w*|COHERE_API_KEY|MISTRAL_API_KEY|STRIPE_\w*KEY|SENDGRID_API_KEY|TWILIO_AUTH_TOKEN|DATADOG_API_KEY|SENTRY_AUTH_TOKEN|AWS_SECRET_ACCESS_KEY)\b/;

const SELF_HOSTED_NOTE =
  "Run the job on your own authorized machine with a self-hosted runner (no hosted minutes are used), or run the same commands locally through an approved CodeBridge gate. Never attach a self-hosted runner to a public repository that runs untrusted pull-request code.";

// Workflow files are repository-controlled input. Cap the line length before any regular
// expression runs so a crafted line (for example hundreds of KiB of whitespace) cannot make the
// scan super-linear and stall the agent; longer lines are skipped and counted, never parsed.
const MAX_LINE = 2000;

function stripComment(raw) {
  const space = raw.indexOf(" #");
  const tab = raw.indexOf("\t#");
  const cut = [space, tab].filter((i) => i >= 0);
  return cut.length ? raw.slice(0, Math.min(...cut)) : raw;
}

function excerpt(line) {
  return line.trim().slice(0, 140);
}

function add(findings, finding) {
  findings.push({ ...finding, evidence: excerpt(finding.evidence ?? "") });
}

function hostedRunnerFinding(file, lineNo, value, text) {
  const v = value.toLowerCase();
  const mac = v.includes("macos");
  const win = v.includes("windows");
  return {
    id: "HOSTED_RUNNER",
    severity: mac ? "high" : win ? "medium" : "low",
    file,
    line: lineNo,
    message: mac
      ? "GitHub-hosted macOS runner. If this repository is private it consumes included minutes at a much higher rate than Linux."
      : win
        ? "GitHub-hosted Windows runner. If this repository is private it consumes included minutes at a higher rate than Linux."
        : "GitHub-hosted Linux runner. Free for public repositories; private repositories draw on the account's included minutes.",
    freeAlternative: SELF_HOSTED_NOTE,
    evidence: text,
  };
}

function cronFinding(file, lineNo, cron, text) {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [minute, hour] = parts;
  if (hour !== "*") return null;
  const match = /^\*(?:\/(\d+))?$/.exec(minute);
  if (!match) return null;
  const every = match[1] === undefined ? 1 : Number(match[1]);
  if (!Number.isInteger(every) || every < 1) return null;
  const perHour = Math.floor(60 / every);
  return {
    id: "FREQUENT_SCHEDULE",
    severity: perHour >= 4 ? "high" : "medium",
    file,
    line: lineNo,
    message: `Scheduled roughly ${perHour} time(s) per hour. A polling schedule keeps consuming runner time even when nothing changed.`,
    freeAlternative:
      "Trigger on push/pull_request instead of polling, lengthen the interval (for example once a day), or poll from your own machine with a local timer.",
    evidence: text,
  };
}

function auditGitHubWorkflow(file, content, findings, counters) {
  const lines = content.split(/\r?\n/);
  let inJobs = false;
  let job = null;
  const jobs = [];
  let hasTriggerPushOrPr = false;
  let concurrencyLine = 0;
  let cancelInProgress = false;

  lines.forEach((raw, index) => {
    const lineNo = index + 1;
    if (raw.length > MAX_LINE) {
      counters.longLines += 1;
      return;
    }
    const line = stripComment(raw);
    if (/^on:/.test(line) || /^\s{2}(push|pull_request)\s*:/.test(line))
      hasTriggerPushOrPr ||= /(push|pull_request)/.test(line);
    if (/^on:\s*\[?.*\b(push|pull_request)\b/.test(line))
      hasTriggerPushOrPr = true;
    if (/^concurrency:/.test(line)) concurrencyLine = lineNo;
    if (/^\s+cancel-in-progress:\s*\S/.test(line)) cancelInProgress = true;

    const cron = /^\s*-\s*cron:\s*['"]?([^'"]+?)['"]?\s*$/.exec(line);
    if (cron) {
      const f = cronFinding(file, lineNo, cron[1], raw);
      if (f) add(findings, f);
    }

    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      return;
    }
    if (inJobs && /^\S/.test(line) && line.trim()) inJobs = false;
    if (inJobs) {
      const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (header) {
        job = {
          id: header[1],
          line: lineNo,
          timeout: false,
          runsOn: false,
          selfHosted: false,
          matrix: false,
          maxParallel: false,
        };
        jobs.push(job);
      } else if (job) {
        if (/^ {4}timeout-minutes:/.test(line)) job.timeout = true;
        if (/^ {6}matrix:/.test(line)) job.matrix = true;
        if (/^ {6}max-parallel:/.test(line)) job.maxParallel = true;
        const runsOn = /^ {4}runs-on:\s*(.+?)\s*$/.exec(line);
        if (runsOn) {
          job.runsOn = true;
          const value = runsOn[1];
          if (/self-hosted/i.test(value)) {
            job.selfHosted = true;
            add(findings, {
              id: "SELF_HOSTED",
              severity: "info",
              file,
              line: lineNo,
              message:
                "Runs on a self-hosted runner: no GitHub-hosted minutes are used. Keep it off untrusted pull-request code.",
              freeAlternative: "",
              evidence: raw,
            });
          } else if (/(ubuntu|windows|macos)-/i.test(value)) {
            add(findings, hostedRunnerFinding(file, lineNo, value, raw));
          }
        }
      }
    }

    if (PAID_CREDENTIAL.test(line)) {
      add(findings, {
        id: "PAID_SERVICE_CREDENTIAL",
        severity: "medium",
        file,
        line: lineNo,
        message: `Workflow references a credential name for a metered or paid service (${PAID_CREDENTIAL.exec(line)[1]}). Calls made with it may be billed to the account that owns the key.`,
        freeAlternative:
          "Use a local model or a free-tier/offline test double for CI, and make a paid call opt-in and budget-capped by its owner.",
        evidence: raw,
      });
    }
  });

  // A schedule whose jobs all run on your own self-hosted runner uses no hosted minutes; it still
  // loads your machine, so it is reported as information rather than as a spend risk.
  const running = jobs.filter((j) => j.runsOn);
  if (running.length > 0 && running.every((j) => j.selfHosted))
    for (const f of findings)
      if (f.file === file && f.id === "FREQUENT_SCHEDULE") {
        f.severity = "info";
        f.message = `${f.message} All jobs use a self-hosted runner, so no hosted minutes are consumed, but your own machine does the work each time.`;
      }

  for (const j of jobs)
    if (j.runsOn && j.matrix && !j.maxParallel)
      add(findings, {
        id: "MATRIX_NO_MAX_PARALLEL",
        severity: "low",
        file,
        line: j.line,
        message: j.selfHosted
          ? `Job "${j.id}" fans out a matrix with no max-parallel, so every combination can run at once on your own machine and saturate it.`
          : `Job "${j.id}" fans out a matrix with no max-parallel, so every combination can start at once and multiply the minutes used.`,
        freeAlternative:
          "Add strategy.max-parallel (1–2 on a self-hosted runner) and trim matrix entries you do not need.",
        evidence: `${j.id}: strategy.matrix`,
      });

  for (const j of jobs)
    if (j.runsOn && !j.timeout)
      add(findings, {
        id: "NO_TIMEOUT",
        severity: "medium",
        file,
        line: j.line,
        message: `Job "${j.id}" has no timeout-minutes, so a hung job can run for the platform default (hours) before it stops.`,
        freeAlternative:
          "Add timeout-minutes sized to the job's normal runtime (for example 15–30).",
        evidence: `${j.id}:`,
      });

  if (hasTriggerPushOrPr && !concurrencyLine)
    add(findings, {
      id: "NO_CONCURRENCY",
      severity: "low",
      file,
      line: 1,
      message:
        "Push/pull_request workflow without a concurrency group: superseded commits keep running to completion.",
      freeAlternative:
        "Add a concurrency group with cancel-in-progress: true so only the newest commit's run is kept.",
      evidence: "concurrency: (missing)",
    });
  else if (concurrencyLine && !cancelInProgress)
    add(findings, {
      id: "NO_CANCEL_IN_PROGRESS",
      severity: "low",
      file,
      line: concurrencyLine,
      message:
        "Concurrency group without cancel-in-progress: an older run still finishes before the newer one starts.",
      freeAlternative: "Set cancel-in-progress: true for CI (not for deploys).",
      evidence: "concurrency:",
    });
}

function auditCircle(file, content, findings, counters) {
  const lines = content.split(/\r?\n/);
  lines.forEach((raw, index) => {
    if (raw.length > MAX_LINE) {
      counters.longLines += 1;
      return;
    }
    const line = stripComment(raw);
    const rc = /^\s*resource_class:\s*['"]?([A-Za-z0-9_./-]+)['"]?\s*$/.exec(
      line,
    );
    if (rc && !["small", "medium"].includes(rc[1]))
      add(findings, {
        id: "PREMIUM_RESOURCE_CLASS",
        severity: "medium",
        file,
        line: index + 1,
        message: `Resource class "${rc[1]}" may not be included in a free plan; verify against your plan before relying on it.`,
        freeAlternative:
          "Use small/medium, or run heavy builds on your own machine through an approved CodeBridge gate.",
        evidence: raw,
      });
    if (/^\s*macos:\s*$/.test(line) || /^\s*-\s*image:.*gpu/i.test(line))
      add(findings, {
        id: "PREMIUM_EXECUTOR",
        severity: "high",
        file,
        line: index + 1,
        message:
          "macOS or GPU executors are typically metered or plan-restricted; verify before relying on them.",
        freeAlternative:
          "Build macOS/GPU targets on hardware you own and attach the receipt as evidence.",
        evidence: raw,
      });
    if (PAID_CREDENTIAL.test(line))
      add(findings, {
        id: "PAID_SERVICE_CREDENTIAL",
        severity: "medium",
        file,
        line: index + 1,
        message: `Configuration references a credential name for a metered or paid service (${PAID_CREDENTIAL.exec(line)[1]}).`,
        freeAlternative:
          "Use a local model or an offline test double, and make paid calls opt-in with a budget cap.",
        evidence: raw,
      });
  });
}

export function auditFreeFirst(files) {
  if (!Array.isArray(files)) throw new TypeError("files must be an array");
  const findings = [];
  const checked = [];
  const counters = { longLines: 0 };
  for (const { path, content } of files) {
    if (typeof path !== "string" || typeof content !== "string") continue;
    checked.push({ path, bytes: Buffer.byteLength(content) });
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(path))
      auditGitHubWorkflow(path, content, findings, counters);
    else if (/^\.circleci\/config\.ya?ml$/i.test(path))
      auditCircle(path, content, findings, counters);
  }
  const summary = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) summary[f.severity] += 1;
  const spendRisk =
    summary.high > 0 ? "high" : summary.medium > 0 ? "medium" : "low";
  return {
    checkedFiles: checked,
    findings: findings.slice(0, 200),
    findingsTruncated: findings.length > 200,
    longLinesSkipped: counters.longLines,
    summary,
    spendRisk,
    advisory:
      "Advisory only. This reads configuration text; it cannot see your billing plan, repository visibility or provider quotas, so a finding means 'may cost money under that condition', not 'will'. Alternatives are limited to your own hardware, local models and free tiers used within their terms.",
  };
}
