# CloudOS GitHub allowlist recovery (exact repository only)

Native CodeBridge GitHub tool calls for `kmjtechno/kmj-cloudos` returned
`GITHUB_REPOSITORY_DENIED` on 2026-10-18, while the separately connected
GitHub application could read CloudOS PRs. This means the *running CodeBridge
gateway* does not authorize the exact CloudOS repository. It does not prove the
gateway-held GitHub credential can access the repo.

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

If CloudOS is temporarily **public**, this protected *private-grant* helper
refuses to claim that private GitHub App access is proven. Do not weaken its
gate; re-review repository visibility and proper app installation scope.

The tool does not run host shell commands through CodeBridge, deploy
CloudOS, change DNS, billing, licensing, passwords or commercial release
status. CloudOS Phase-1 independent acceptance and protected PR review
remain separate.

See `docs/PRIVATE-GITHUB-ALLOWLIST-RECOVERY.md` for a similar but strictly
separate Main Platform operation.
