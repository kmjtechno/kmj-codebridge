# KMJ P520 — one-click prepared Supervisor activation

Status: source-only review candidate, not deployed to P520. This flow is
for the already prepared, disabled P520 Supervisor task, not a fresh installer.

## Owner experience

After reviewing the exact source commit, right-click
scripts/windows/ONE-CLICK-P520-ACTIVATE-20261117.cmd and select Run as
administrator. The launcher performs the bounded activation and verification
with one owner action, not a chain of terminal commands.

The launcher verifies the P520 identity, pinned release and origin, unique
backup manifest, hashes of backups/token/proposed config, task action and
principal, token ACL, proposed-only delta, and single connected agent.
It refuses inconsistent state and never repeats installation or git cleanup.
After starting only the prepared Supervisor task, it authenticates status
and config using the existing HMAC named-pipe protocol. Failed activation
attempts to stop and disable the task and explicitly reports rollback status.

Successful output includes P520_ONE_CLICK=PASS and
P520_ONE_CLICK_AGENT_WIRING=PENDING_SEPARATE_GUARDED_HANDOFF.
That result proves only the persistent local Supervisor. Existing agent.json,
enrollment and OmniDesk remain untouched, and no second agent is started.
An independently reviewed idle-gated agent-wiring transaction and fresh remote
supervisor_status(agent) remain necessary for full CodeBridge supervisor use.
Autonomous coding worker activation and inference routing are out of scope.

## Review, test, and failure

The PowerShell script is read-only by default (omit -Apply). SelfTest is
synthetic and can run in Windows CI. An owner-facing CMD launcher chooses
-Apply intentionally after administrator elevation. CI parser and static
tests cover guardrails but cannot prove live production behavior.

P520 owner already reported disabled task, ACL/task action, proposal delta,
ephemeral HMAC, post-HMAC single-agent and rollback dry-run PASS; do not
re-run the old installer or remove backups. If rollback reports
P520_ONE_CLICK_ROLLBACK=FAILED_MANUAL_REVIEW, preserve files and inspect
the disabled task manually rather than retrying blindly.
