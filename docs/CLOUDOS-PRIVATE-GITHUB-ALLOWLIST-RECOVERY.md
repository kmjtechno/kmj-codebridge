# CloudOS GitHub allowlist recovery (exact repository only)

Native CodeBridge GitHub tool calls for `kmjtechno/kmj-cloudos` returned
`GITHUB_REPOSITORY_DENIED` on 2026-10-18, while the separately connected
GitHub application could read CloudOS PRs. This means the _running CodeBridge
gateway_ does not authorize the exact CloudOS repository. It does not prove the
gateway-held GitHub credential can access the repo.

## Render-hosted gateway: explicit scoped environment opt-in

When the active gateway is hosted on Render and `github` comes from a
protected environment-held config, there may be no operator-accessible
`gateway.json` path. An owner may configure the exact switch
`CODEBRIDGE_ENABLE_CLOUDOS_REPOSITORY=true` **only after** reviewing its
existing authenticated GitHub proxy/app scope. This switch is off by
default and adds only `kmjtechno/kmj-cloudos`; it does not change
GitHub App installation permissions, token contents, unrelated repositories,
public-read-only policy, OAuth scopes or CI/protected-branch rules.

The hosted parser refuses this setting if the GitHub bridge is disabled,
anonymous/public read-only, or missing an existing server-side tokenEnv.
Changes to this variable cause a Render service redeploy: require a reviewed
CI-green commit, an existing healthy deployment/rollback, and no unapproved
paid resources. Confirm the **running** gateway's
`github_connection_doctor({repository:"kmjtechno/kmj-cloudos"})`
returns `read_ready` with `privateRepository=true`. The setting alone is
**not** evidence the proxy/credential can read CloudOS. Test that an unrelated
repository remains denied, preserve current CodeBridge/CineCore grants,
and do not claim CloudOS production readiness from GitHub metadata.

If the new exact repo is not `read_ready`, revert the environment flag to
`false` using the existing operator rollback and investigate the upstream
GitHub App installation/proxy permissions. Never replace the complete
`CODEBRIDGE_GITHUB_REPOSITORIES` list with a guessed value; do not add a
wildcard or expose token/config values to chat. The protected Linux gateway
procedure below remains the supported path for an on-host config file.

## Protected gateway operator procedure

Use the installed matching version of this source, an **authorized root
operator on the gateway host**, and the effective protected gateway config.
Do **not** paste service environment, access tokens, gateway JSON, private
key material or actual config paths into ChatGPT.

1. Identify the running gateway and the effective `gateway.json` file,
   existing token environment, SHA, ownership and mode. Back up your production
   configuration using your existing protected backup policy.
2. In the trusted shell with its existing GitHub App token environment loaded,
   run **read-only**:
   `node scripts/repair-private-cloudos-repo.mjs --check /ABSOLUTE/PROTECTED/gateway.json`
3. This confirms the exact repository metadata is **private** and its
   `refs/heads/main` ref can be read via authenticated `api.github.com`
   requests. It rejects anonymous/public read, redirects, missing token and
   wrong repo, and prints only a bounded verdict and the input config SHA.
4. If and only if the operator approves, apply using the exact reported SHA:
   `node scripts/repair-private-cloudos-repo.mjs --apply /ABSOLUTE/PROTECTED/gateway.json EXACT_INPUT_SHA256`
   The tool adds only `kmjtechno/kmj-cloudos`, preserves existing config
   settings and file owner/mode, writes an exclusive protected backup and
   atomically swaps config. No wildcard and no grant to another repo.
5. **No automatic restart** occurs. Use the existing separately approved
   gateway cutover/rollback procedure with active-job fencing to reload the
   config. Verify a CloudOS read call, an unauthorized cross-repository denial
   and that Main Platform / CodeBridge repo scopes are unchanged.

If CloudOS is temporarily **public**, this protected _private-grant_ helper
refuses to claim that private GitHub App access is proven. Do not weaken its
gate; re-review repository visibility and proper app installation scope.

The tool does not run host shell commands through CodeBridge, deploy
CloudOS, change DNS, billing, licensing, passwords or commercial release
status. CloudOS Phase-1 independent acceptance and protected PR review
remain separate.

See `docs/PRIVATE-GITHUB-ALLOWLIST-RECOVERY.md` for a similar but strictly
separate Main Platform operation.
