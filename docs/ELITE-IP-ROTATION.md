# KMJ-elite origin IP rotation (one click)

`config/elite-origin.json` is the single source of truth for the KMJ-elite
public origin IPv4 and its SSH ED25519 host-key pin.

## When the server IP changes

1. GitHub → **Actions** → **Rotate KMJ-elite origin IP** → **Run workflow** →
   enter the new IPv4 → **Run**.
2. The workflow validates the address (public IPv4 only), rewrites only the
   `managedFiles`, keeps the SSH pin unchanged, runs every offline guard and
   opens a pull request (or prints a one-click compare link if Actions may not
   open PRs in this repository).
3. Close and reopen that PR once so CI runs (PRs opened by `GITHUB_TOKEN` do
   not trigger CI), then merge it when green.

Workflows read the IPv4 from the config at run time, so no workflow file is
ever rewritten.

## What it deliberately does not do

- No DNS, Cloudflare, SSH, GCE, server or production change. Cloudflare DNS A
  records are still updated by the owner. The Cloudflare skip rules are
  path-based and do not depend on the origin IP.
- Files reported as `MANUAL_REVIEW` (billable VM start, SFTP-auth smoke,
  `known_hosts`, legacy rsync) are not rewritten; re-verify the host key on
  the new IP before retargeting them.
- If the server's SSH host key changed too, the read-only probes fail closed
  until the owner re-attests the new fingerprint.

## Local equivalent

```sh
python3 -B scripts/operations/rotate_elite_origin_ip.py --to <new-ipv4>          # dry run
python3 -B scripts/operations/rotate_elite_origin_ip.py --to <new-ipv4> --apply  # write
python3 -B -m unittest discover -s tests -p 'test_elite_*.py'
```
