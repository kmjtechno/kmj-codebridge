# Default-off signed metering pilot

This is a paired source change with Main Platform PR #1152, not a commercial release.

- Only successful `git_status` calls for one configured tenant are reserved and settled. Other tools, Team seats and failure/cancellation reconciliation are not implemented by this pilot.
- Enable only on an isolated environment after both exact heads pass CI. Configure the dedicated gateway token through its environment and the SHA-256 hash on the platform; never reuse a customer or agent credential.
- An operator must provision a separate Ed25519 key for the enrolled device, pin its raw public key through the reviewed server-side signer registration, and configure the private PKCS#8 DER base64 single-line file outside all project/state directories with restricted ownership and ACLs. No automatic key rotation or installation is claimed.
- Keep `hostedMeteringPilot` absent and `hostedReceiptKeyFile` absent for ordinary production. No billable customer meter is activated.
- Verify actual reservation, device signature, settlement, rejection of another tenant, and retry/transport loss on isolated PostgreSQL before considering activation. Unknown delivery retains reservations. Do not expose pilot counts as general customer usage.

## POSIX provisioning helper

On a separately approved device identity, the explicit `scripts/provision-hosted-receipt-key.js` helper creates or reuses a protected local key and emits only its public key and `OWNER_PIN_REQUIRED`. It neither mutates agent configuration nor enrolls the key remotely. Windows atomic private ACL creation and owner approval remain separate gates.
