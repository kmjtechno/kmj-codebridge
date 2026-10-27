# Multi-chat parallel CodeBridge work lanes

**One shared CodeBridge gateway can serve multiple concurrent ChatGPT, Claude, IDE and desktop MCP sessions.** The downstream device still enforces actual signed/authorized job concurrency. Multiple chats are not multiple paid/free model credits.

New scoped MCP operations:

- `chat_lane_status({device,project})` — bounded active reservation status; **no lease token** is exposed.
- `chat_lane_reserve({device,project,requestKey,paths,ttlSeconds})` — obtain a 1–60 minute expiring file/directory reservation (write entitlement required), with safe retries using the same request key.
- `chat_lane_release({device,project,leaseToken})` — release only your reserved lane. Never use another chat's token.
- `write_file`, `edit_file`, `write_files_atomic` accept optional `leaseToken`. When a file overlaps an active reservation, a different chat without the matching token receives `CHAT_LANE_CONFLICT`, not a destructive overwrite. Existing expected-SHA and sensitive-binding checks still apply.

Examples: Chat A reserves `src/api`; Chat B reserves `docs`. Both can edit their files through the same CodeBridge agent without collision. A third chat attempting to edit `src/api/app.ts` must wait or move to a different isolated worktree. This is a **project file cooperation layer**, not a permission to bypass project grants, use untrusted shell, or automatically start autonomous AI models.

**Important limitations**: Git CLI jobs, external manual changes and independent IDEs not using CodeBridge are _not_ locked by this layer. Stronger parallel coding requires separate disposable Git worktrees/PR branches, exact-head CI and collision reviews. The per-process agent singleton holds the durable reservation journal; arbitrary duplicated agents sharing the state directory are not supported. Status reads never grant access to another tenant's project.

## Update and Claude Desktop truth

- Remote OAuth MCP clients (ChatGPT web, Claude web, Claude Desktop managed MCP, VS Code) fetch tools from the hosted gateway. A **verified gateway rollout** refreshes server functionality for newly initialized/synchronized sessions; individual host chats may need reconnection, and KMJ cannot force third-party app software updates or UI logos.
- Linux rootless development agents already use guarded `scripts/auto-update-user.sh`; systemd agents use the controlled development timer. **Stable** production releases require signed immutable manifest, preflight, healthcheck and rollback.
- Claude Desktop normal account mode uses the hosted OAuth MCP connector `https://kmjtechno.com/mcp`. For third-party inference Gateway mode use the managed MCP server path in `docs/CLIENTS.md`. Do not put device tokens in `claude_desktop_config.json`.
- No ChatGPT credit bypass exists. Minimize use via `compact_work_brief`, `context_pack` small budget and bounded read batching; measure actual usage before promising savings.

No release credit until CI, separate gateway deployment and live cross-client test results are verified.

## Share owner-only results without copying terminal output

CodeBridge already provides `run_project_command` / `get_job_status` for approved non-root commands, `chat_continuity_save` / `multi_chat_sync` for a durable project-and-lane checkpoint, and `read_file` for narrowly scoped project artifacts. Root-only procedures remain executed by the owner.

A fixed SHA-pinned owner-side adapter may export **redacted status receipts only** to an approved project directory. For a full safe workflow and current tool-version limitations, see [Shared chat handoffs and operator-only evidence receipts](OPERATOR-RECEIPTS-CROSS-CHAT.md). This never enables an unrestricted remote terminal or wakes an inactive ChatGPT chat.
