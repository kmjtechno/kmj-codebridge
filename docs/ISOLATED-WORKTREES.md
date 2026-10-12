# Isolated worktree lanes for KMJ HyperSpeed

Three native, project/device-scoped operations:
- `worktree_lane_status({device,project})` reads max 4 private worktree identities.
- `worktree_lane_prepare({device,project,laneId,expectedHead,approveLocalGitCheckout:true})` creates a real detached checkout at the exact authorized repository HEAD inside private agent state. No arbitrary shell, downloads or remote hosts.
- `worktree_lane_cleanup({device,project,laneId,confirmLaneId,expectedHead})` removes a matching clean, unchanged disposable checkout; changed files or new commits block deletion. Never uses `--force`.

Each operation preserves the existing source worktree, permission/license checks and audit classification (create: GIT_WRITE; cleanup: DESTRUCTIVE). Checkout may invoke trusted repository filters and requires execute entitlement and deliberate operator approval. Only 4 worktrees per project limit disk usage. New worktrees **do not create extra licensed concurrent workers**.

The new paths are not automatically granted to a connected AI chat as projects. An owner must explicitly authorize each isolated checkout in the agent's project configuration before file edits, quality gates or autonomous workers can run there. Git worktrees can share repository object metadata, but independent working files avoid direct cross-chat edits. This is actual isolation infrastructure, not a working 24x7 swarm or AI model scheduler.

Next milestones: scoped worktree project grants, policy-bound command profiles, ModelFabric free quota ledger, durable AI worker checkpoints and exact-head gate orchestration. No external paid CI is necessary to run local checks; deployment to running devices remains separate.
