# KMJ-elite origin IP rotation (one click)

## What happens when the server IP changes

The Cloudflare Tunnel was removed on 2026-11-12 (owner request). All
website hostnames now reach the origin directly through Cloudflare's proxy.

| Part                                   | How it follows the new IP                                             |
| -------------------------------------- | --------------------------------------------------------------------- |
| kmjtechno.com, staging (A, proxied)    | `kmj-elite-ddns.timer` on KMJ-elite, within 5 minutes                 |
| www, cloudos                           | CNAME to kmjtechno.com — follow the apex automatically                |
| elite-ssh, mail A records + SPF `ip4:` | `kmj-elite-ddns.timer` on KMJ-elite, within 5 minutes                 |
| Repository probes and tests            | GitHub Actions → **Rotate KMJ-elite origin IP** (one click, below)    |
| SSH host key                           | Never changed automatically; a new key fails closed until re-attested |

### One-time setup of the DNS timer (owner, on KMJ-elite)

1. Cloudflare → My Profile → API Tokens → Create token → _Edit zone DNS_,
   zone `kmjtechno.com` only.
2. `sudo bash examples/elite-ddns/install.sh` (paste the token when asked; it
   is stored root-only and never printed; ends with a dry run).
3. `sudo systemctl enable --now kmj-elite-ddns.timer`

The updater only edits the content of those records, only when they still
hold the previously recorded IP and have the expected proxy status, and never
creates or deletes records.

## Repository rotation

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

- No DNS, Cloudflare, SSH, GCE, server or production change. Cloudflare DNS is
  handled by the DDNS timer above. The Cloudflare skip rules are path-based
  and do not depend on the origin IP.
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
