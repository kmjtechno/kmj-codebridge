# Main Platform private GitHub bridge allowlist recovery

This is an **operator-run gated config repair**, NOT an automatic ChatGPT/CodeBridge
tool and not a replacement for secure GitHub permissions. Incident:
[CodeBridge issue #506](https://github.com/kmjtechno/kmj-codebridge/issues/506).

The live CodeBridge gateway returned `GITHUB_REPOSITORY_DENIED` for the
private `kmjtechno/kmj-main-platform` repo. That means the repository was
outside the configured exact `github.repositories` allowlist. It does **not**
prove the server-side GitHub token has permission. Never allow all repositories
or disable `verifyRepo` in `src/github.js`.

## Check without modifying protected config

On the actual gateway host, the authorized operator must identify the
_effective_ protected `gateway.json` path and the existing GitHub App token
environment variable from the protected service configuration. Do **not**
paste the token, service file, gateway JSON or environment contents into chat.

```sh
# Run as an authorized gateway operator, not on Main Platform's app checkout.
# The configured token variable must already be present securely in this
# process environment. Do not export or print it into chat.
node scripts/repair-private-main-platform-repo.mjs \
  --check /ABSOLUTE/PROTECTED/gateway.json
```

This verifies the exact repository against **both** private metadata and
`refs/heads/main` via GitHub API, using only the existing server-held
credential. It refuses anonymous/public-mode fallback, wrong API origins,
missing/invalid secrets, redirects, HTTP !=200 and invalid private grant.

## Apply after reviewing config SHA

In the same trusted shell and with production config backed up by your
standard host backup process, use the `REPO_REPAIR_INPUT_SHA256` shown by
`--check`:

```sh
node scripts/repair-private-main-platform-repo.mjs \
  --apply /ABSOLUTE/PROTECTED/gateway.json <EXACT_CONFIG_SHA256>
```

This operation must run as root, keeps file owner/mode, adds only the exact
`kmjtechno/kmj-main-platform` repository, atomically installs updated JSON
and creates a protected `.kmj-backup-<SHA-prefix>` file. It never adds or
prints tokens, changes OAuth scope, starts the updater, touches Laravel
PostgreSQL, restarts the gateway or runs arbitrary commands. Any failed
preflight leaves the original config unchanged. Backups are never
overwritten; run a separate, audited rollback if live tests fail.

**Safety caveat:** The operator must ensure no concurrent gateway
configuration management process is rewriting the file. This helper
validates the original inode and contents immediately before rename, but
cannot prevent an independent privileged process from racing it.

**Separate gated service activation:** After apply, use the owner's existing
signed/pinned gateway cutover procedure to revalidate the current runtime
and restart only if allowed by the existing zero-active-jobs/rollback checks.
Then confirm the private repository read works, current PRs are visible,
and a different unauthorized repo is still denied. Do not infer live
availability from config changes.

## Other blockers remain separate

- Private Main Platform GitHub Actions fail before jobs run: see
  [Main Platform #437](https://github.com/kmjtechno/kmj-main-platform/issues/437).
  The action is an account/organization quota or policy investigation; we
  have **not** verified the actual reason.
- The connected ChatGPT CodeBridge plugin's `autopilot_complete` tool
  lacks the live agent-required `leaseToken` input. Source already declares
  it; republishing/updating the connector tool schema is necessary before
  autonomous task execution can be reliably acknowledged:
  [CodeBridge #369](https://github.com/kmjtechno/kmj-codebridge/issues/369).
- The Main Platform updater/refresh units were absent during a live audit.
  The helper does not install or start them.
- All work remains ₹0 additional cost. No private repo publicity, paid
  runners, new APIs, bypassed security gates or false CI PASS.
