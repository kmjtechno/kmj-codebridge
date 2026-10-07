# CodeBridge owner signed-plan activation

The Main Platform operator grants the CodeBridge owner plan to an **existing
Professional license**. This alone does not change a free-mode agent. The
agent must receive a real device-bound Ed25519-signed entitlement from Main
Platform's authenticated renewal endpoint.

The supported Linux owner-assisted activation helper is:

```bash
node scripts/activate-owner-admin.js \
  /etc/kmj-codebridge/agents/<existing-agent>.json \
  /etc/kmj-codebridge/owner-public-keys.json \
  /etc/kmj-codebridge/owner-device-credential
```

Do **not** paste a credential, signing key, signed lease, agent configuration
or API token into ChatGPT or GitHub. The public keys file is a JSON object
mapping signing key IDs to the **trusted public** SPKI PEMs; obtain it from
Main Platform's authenticated signing-key distribution. The credential file
must contain the already enrolled, active **device** renewal credential. Both
the credential and agent configuration must be regular files with private
permissions (0600), never symlinks. Use a trusted operator with appropriate
filesystem permissions.

The helper:

- Requires existing `license.mode=free` and valid agent configuration.
- Calls the fixed `https://kmjtechno.com/api/v1/codebridge/renew` endpoint
  using the existing device credential, starting at sequence -1.
- Verifies the returned signature, trusted key, tenant/device binding, active
  expiry, strict owner-plan limits (16 signed slots; 2,147,483,647 devices),
  and read/write/execute features **before** changing any file.
- Saves a private original-config backup, private signed lease and atomically
  replaces only the license configuration; all project grants are preserved.
  The renewable lease is placed in the agent's writable private state directory,
  not the read-only system configuration directory.
- Does not restart services or print credentials. The operator must
  explicitly restart the existing agent and check `execution_capacity`
  after confirming the backup and lease.

Never use this to mint an entitlement or modify the license without owner
approval. If the endpoint, credential, signer or grant is unavailable,
activation fails closed and the free-mode agent remains in place.

Windows activation is intentionally disabled until native ACL verification
is implemented. The job scheduler still respects CPU/RAM/disk pressure and
its durable queue limits; signed concurrency is a ceiling, not a guarantee.

**Current deployment status:** the helper is an opt-in release capability,
not evidence that the user's live agent is in signed mode. Only a successful
operator run, agent restart and verified capacity prove activation.
