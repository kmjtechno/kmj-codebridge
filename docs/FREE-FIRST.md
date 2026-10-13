# Free-first operation (zero extra spend, legal)

KMJ CodeBridge is designed so that real engineering work can run on **hardware you already own**, with **local models** and **free tiers used inside their terms**, and so that spending is visible before it happens. This page is the operating guide. It is not a billing statement: CodeBridge cannot see your provider plan, quotas or invoices.

## Rules that keep it free and legal

1. **Own hardware first.** Builds, tests, local model inference and QA run on the authorized device through approved gates and command profiles. No source leaves the device and nothing is rented.
2. **Free tiers only within their terms.** Use the included allowance of a provider's free plan, and stop at the limit. Do not create extra accounts, rotate keys or split projects to multiply a quota, and do not bypass a provider's limits or terms.
3. **No hidden paid fallback.** A paid API, larger runner or metered service is never used automatically. If one is wanted, its owner enables it explicitly with a budget cap.
4. **Licenses matter.** Check each local model's and tool's license before commercial use or redistribution; free to download is not the same as free to ship.
5. **Do not publish private source to gain minutes.** Public-repository allowances are for projects that are genuinely meant to be public.

## Where work can run at no extra cost

| Work                            | Free path                                                                                                                                 | Notes                                                                                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Build, test, lint, package      | Approved CodeBridge gates and command profiles on your own machine (`run_quality_gate`, `run_project_command`, isolated worktree lanes)   | Receipts show the exact result of the exact run. A local result is evidence, not a hosted CI check, and does not satisfy branch protection.  |
| Continuous integration          | A self-hosted runner on your own machine                                                                                                  | GitHub does not bill Actions minutes for self-hosted runners. Never attach one to a public repository that runs untrusted pull-request code. |
| Continuous integration (hosted) | The included minutes of your plan, with a **$0 metered budget and "stop usage"** enabled in the provider's billing settings               | Standard hosted runners are only free up to the included allowance for private repositories; Windows and macOS consume it faster than Linux. |
| Code drafting and diagnostics   | Local models through `local_model_generate` (for example Qwen via a local Ollama), when installed                                         | Local only: it never calls an external provider and never downloads a model. Verify and compile every generated change.                      |
| Review and PR work              | Native GitHub tools (`github_pull_request*`, `github_review_pull_request`, `github_update_pull_request`, ...) with the gateway credential | No external plugin is needed.                                                                                                                |

## `free_first_audit`: find spend before it happens

The read-only MCP tool `free_first_audit` scans the project's CI configuration (`.github/workflows/*.yml`, `.circleci/config.yml`) and reports settings that **may** consume paid minutes or metered services, each with a legal free alternative. It reads configuration text only: it executes nothing, contacts no provider and never sees secret values (workflow files contain secret _names_).

| Finding                                                 | Why it matters                                                                                        | Free alternative                                                                  |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `HOSTED_RUNNER` (macOS high, Windows medium, Linux low) | Hosted runners draw on included minutes in private repositories                                       | Self-hosted runner or an approved local CodeBridge gate                           |
| `FREQUENT_SCHEDULE`                                     | A polling schedule keeps running when nothing changed (`*/15` is 96 runs a day)                       | Trigger on push/pull request, lengthen the interval, or poll locally              |
| `NO_TIMEOUT`                                            | A hung job can run for hours before the platform default stops it                                     | Add `timeout-minutes` sized to the normal runtime                                 |
| `MATRIX_NO_MAX_PARALLEL`                                | A matrix starts every combination at once: it saturates your own machine or multiplies hosted minutes | Add `strategy.max-parallel` (1–2 on a self-hosted runner) and drop unused entries |
| `NO_CONCURRENCY` / `NO_CANCEL_IN_PROGRESS`              | Superseded commits keep running to completion                                                         | Concurrency group with `cancel-in-progress: true` for CI (not for deploys)        |
| `PAID_SERVICE_CREDENTIAL`                               | A credential name for a metered or paid API is referenced                                             | Local model or offline test double; paid calls opt-in with a budget cap           |
| `PREMIUM_RESOURCE_CLASS` / `PREMIUM_EXECUTOR`           | Larger, macOS or GPU executors may not be in a free plan                                              | `small` / `medium`, or build on your own hardware                                 |
| `SELF_HOSTED` (info)                                    | Confirms a job uses your own runner (no hosted minutes)                                               | Keep it off untrusted pull-request code                                           |

A schedule whose jobs all run on a self-hosted runner is reported as information, not as a spend risk, because it uses no hosted minutes (it still loads your machine).

Limits, stated plainly: the audit is a line-based scan, not a full YAML or expression evaluator; it cannot know your plan, repository visibility or quotas, so a finding means "may cost money under that condition". Treat `spendRisk` as a prompt to look, not as an invoice.

## Budget checklist

- Keep a **$0 metered budget with stop-usage** and usage alerts enabled at the provider. A past-due balance or billing restriction must be resolved with the provider's billing support; changing workflow files cannot cancel a charge.
- Cancel superseded runs, set job timeouts, scope triggers with path filters and cache dependencies by lockfile.
- Prefer one meaningful job over many that each repeat the same install.
- Review `free_first_audit` after any workflow change.

## Keep your own servers lightly loaded

Free-first moves work onto machines you own, so those machines must stay healthy.

- **Built-in guards.** Each device runs one CodeBridge job at a time by default (`configuredMaxConcurrent: 1`) with a bounded queue (64). `execution_capacity` reports load per CPU, free memory and free disk, and the agent holds back new work when memory is under 10% free, load per CPU is above 1.5, or free disk/memory fall under the minimum thresholds. Read it before starting heavy work.
- **Snapshot, not a guarantee.** A read-only `execution_capacity` check on 2026-10-13 showed the Main Platform server (16 CPUs) at load 0.03 with about 94% memory and roughly 1 TB disk free, and the P720 (24 CPUs) at load 0 with about 55% memory and 500 GB disk free. Re-check before relying on it.
- **A self-hosted runner runs one job at a time per runner process.** Do not start several runner processes on a machine that also serves production traffic, and avoid unbounded matrices (`MATRIX_NO_MAX_PARALLEL`).
- **Optional limits (owner-applied, tune the numbers).** A systemd drop-in for the runner service keeps CI from starving other work, for example:

  ```ini
  # /etc/systemd/system/actions.runner.<name>.service.d/limits.conf
  [Service]
  Nice=10
  IOSchedulingClass=idle
  CPUQuota=800%
  MemoryMax=12G
  ```

  then `systemctl daemon-reload` and restart the runner service. Restarting a service is a privileged owner action; CodeBridge does not do it for you.

- **Never share a CI machine with production secrets or data.** Test against disposable databases and ephemeral keys.
