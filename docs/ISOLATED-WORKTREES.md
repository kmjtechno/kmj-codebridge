# Isolated worktree lanes for KMJ HyperSpeed

Three native, project/device-scoped operations:

- `worktree_lane_status({device,project})` reads max 4 private worktree identities.
- `worktree_lane_prepare({device,project,laneId,expectedHead,approveLocalGitCheckout:true})` creates a real detached checkout at the exact authorized repository HEAD inside private agent state. No arbitrary shell, downloads or remote hosts.
- `worktree_lane_cleanup({device,project,laneId,confirmLaneId,expectedHead})` removes a matching clean, unchanged disposable checkout; changed files or new commits block deletion. Never uses `--force`.

Each operation preserves the existing source worktree, permission/license checks and audit classification (create: GIT_WRITE; cleanup: DESTRUCTIVE). Checkout may invoke trusted repository filters and requires execute entitlement and deliberate operator approval. Only 4 worktrees per project limit disk usage. New worktrees **do not create extra licensed concurrent workers**.

The new paths are not automatically granted to a connected AI chat as projects. An owner must explicitly authorize each isolated checkout in the agent's project configuration before file edits, quality gates or autonomous workers can run there. Git worktrees can share repository object metadata, but independent working files avoid direct cross-chat edits. This is actual isolation infrastructure, not a working 24x7 swarm or AI model scheduler.

Next milestones: scoped worktree project grants, policy-bound command profiles, ModelFabric free quota ledger, durable AI worker checkpoints and exact-head gate orchestration. No external paid CI is necessary to run local checks; deployment to running devices remains separate.

## Exact-head Main Platform UI dependency bootstrap (opt-in)

When `main_platform_ui_ci/check` or `build` fails with `vp: not found`, the UI app’s npm lockfile is at `apps/platform/package-lock.json`, not the repository root. Installation is **not** implicit in quality gates. From an authorized, writable `kmj-elite-main-platform / kmj-main-platform` connection, call the existing `run_project_command` operation with `command="main_platform_ui_deps"`, `variant="ci"`, and a unique `requestKey`. Only after its terminal job result is `succeeded`, retry the fixed `main_platform_ui_ci` profile variants `check`, `types` and `build`.

The explicit bootstrap uses the same existing SHA-derived `mainplatform_ci_<12-character HEAD>` private detached Git worktree; it **never** installs into the production/shared checkout. It checks the real committed app package and lockfile for exact `vite-plus@0.3.0`, rejects symlinks and changed worktrees, rechecks the HEAD and lock before executing the queued job, and runs fixed argv `npm --prefix apps/platform ci --ignore-scripts --no-audit --no-fund --prefer-offline`, bounded to 180 seconds. This may download ordinary npm packages when cache is empty; it neither buys services nor invokes npm lifecycle scripts. It is not an arbitrary installer, generic shell, extra concurrent worker, production deploy, or automatic fix for missing PHP `vendor/`.

Installing dependencies is a deliberate requested action; callers should first confirm the package-lock remains trusted and the correct authorized project is selected. Its result is a job receipt, **not** proof that app checks passed. Run checks separately at the same exact checkout HEAD and report their actual results. `WorktreeLanes` allows at most four private lanes per project and never force-cleans dirty or changed lanes.
