# OmniDesk native GitHub repository authorization — Render gateway

## Exact owner-approved scope

This is an operator-controlled opt-in for the **existing** CodeBridge gateway:
`CODEBRIDGE_ENABLE_OMNIDESK_REPOSITORY=true` adds **only**
`kmjtechno/kmj-omnidesk` to the effective private GitHub repository allowlist.

Default is OFF. Only the exact string `true` activates; `false` and absence
preserve the current list. Any other value fails startup closed with
`HOSTED_CONFIG_INVALID`. The parser also refuses opt-in without an already
configured authenticated, private-capable GitHub bridge; it never creates or
exposes a token, switches to anonymous/public mode, changes OAuth/device
grants, overwrites existing repositories or authorizes arbitrary repos.

This switch is source-level preparation, **not evidence of live authorization**.

## Owner/operator activation

1. Confirm the running instance is the owner-approved Render
   `kmj-codebridge-gateway`, using the expected branch/commit, and inspect
   its existing deployment status, rollback, and account/scopes.
2. Verify the existing gateway's GitHub proxy/app credential has read and
   appropriate write permission for the **exact** OmniDesk repository, without
   printing, copying or replacing any secret or effective allowlist in chat.
   GitHub plugin access does not prove gateway access.
3. Obtain exact-head CI success and owner-authorized code review before merging
   this change to the deployed source. Render currently uses main auto-deploy;
   do not manually trigger a duplicate deploy.
4. Once the new commit is deployed healthy, set the **single** Render
   environment key `CODEBRIDGE_ENABLE_OMNIDESK_REPOSITORY=true` using the
   _merge_ update action (`replace=false`). Do not rewrite
   `CODEBRIDGE_GITHUB_REPOSITORIES` or protected `CODEBRIDGE_CONFIG_JSON`.
   Environment change can redeploy; preserve the current healthy rollback.
5. After new deployment is healthy, run
   `github_connection_doctor({repository:"kmjtechno/kmj-omnidesk"})`.
   Require `read_ready`, then verify real PR read and CI evidence. Confirm
   a non-allowlisted repository still returns `repository_not_allowed`,
   and existing CodeBridge/CloudOS/Calibration repository access is unchanged.
6. Only after exact-head checks, owner-approved review, and branch protection
   allow it, merge OmniDesk security PR #203 into its **non-main** parent #202.
   This is not commercial release approval.

## Failures and rollback

If new deployment is unhealthy, proxy/token cannot access the repo, or access
widens unexpectedly, set `CODEBRIDGE_ENABLE_OMNIDESK_REPOSITORY=false` via
the merge environment update and revert the deployed release using the existing
authorized rollback process. Recheck deny-by-default and the original
repositories. Do not disable `verifyRepo`, use wildcard entries, grant a new
GitHub identity to an agent, leak tokens, alter production main, or claim
signed installer/remote-desktop licensing readiness.

OmniDesk commercial release remains blocked by signed Main Platform
entitlements, physically observed two-Windows-PC remote-control, verified
consent and revocation, real NAT/relay tests, locked V7 visual parity and
publisher-signed Windows installers.
