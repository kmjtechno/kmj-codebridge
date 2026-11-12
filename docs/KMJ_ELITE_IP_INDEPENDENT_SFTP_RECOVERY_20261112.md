# KMJ-elite recovery SFTP: dynamic SSH name (12 Nov 2026)

**Source-only, not deployed.** Previously the Google N2-to-ELITE SFTP smoke
used a hardcoded public IPv4 of `103.212.136.154`, causing automatic
future-server-IP breakage. Cloudflare currently has a separate DNS-only A
record, `elite-ssh.kmjtechno.com`, pointing to the attested KMJ-elite
origin `150.242.200.81`, TTL 120s. The Main Platform IP Autopilot
(`feat/ip-agnostic-origin-autopilot-20261112`) has a `direct_only`
mode that is designed to keep **both** mail and SSH DNS-only A records
updated after web domains move to Cloudflare Tunnel.

## This branch

- Updates the approved SFTP smoke program to connect to the DNS-only SSH
  hostname, while preserving `ELITE_ED25519_HOST_PIN` =
  `SHA256:uLP3I92NNheo+MIPWs77aU11NCTK5NrZGwUV0l1QgQI`.
  This exactly matches the locally attested KMJ-elite ED25519 public key;
  **no TOFU and no disabling StrictHostKeyChecking**.
- Uses `ELITE_IP` as a compatibility alias for the DNS hostname in
  one legacy module. Its callers and mock tests are updated to the
  same FQDN. `ssh-keyscan -4` may receive a hostname, but the key
  remains pinned by fingerprint **before** authentication.
- Updates the source-only negative SFTP restrictions module and three
  related regression fixture files. No SFTP writes, SSH logins, private
  identities, systemd changes, GCE instance changes or DNS patches
  were made by this GitHub branch.

## Deployment/verification gates

1. Full regression suite on exact branch head, including the five changed
   source/test files; no GitHub-hosted paid CI automatically.
2. Verify the authoritative `elite-ssh.kmjtechno.com` A record is
   **DNS-only and unique**; verify the relay has an unblocked outbound
   SSH path to the returned address.
3. Run a bounded read-only `--inspect` on the actual existing GCE relay
   under its nonroot uploader identity; confirm the ED25519 fingerprint
   is exact. Only then perform an authenticated SFTP read-only smoke.
4. This branch does **not** replace independent offsite backup
   restore/retention evidence and does not bypass the protected release gate.

## Historical scripts

Several pre-IP-change CodeBridge/GCE relay **setup/preflight**
scripts under `scripts/operations/gce_*` and two historical workflows
still contain `103.212.136.154`. They are not activated by this
SFTP smoke change. Do not run those historical scripts until a
separately reviewed dynamic-host migration updates their independent
numeric IPv4 validators. Similarly, the CloudOS repository has
historical relay bootstrap files with the old IP; audit and fix before
reusing them. This is a remaining source-level compatibility blocker,
not live production success.
