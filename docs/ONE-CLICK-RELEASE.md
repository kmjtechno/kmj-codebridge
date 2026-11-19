# One-command stable release

Before this, every release meant hand-copying a new
`publish-signed-stableNN.yml` with pinned hashes (seq29 even shipped seq28
values by mistake, fixed in #980). Now there is one command and one workflow.

## One-time setup (owner PC)

Create `~/.config/kmj-codebridge/release.env` with two lines:

```
CODEBRIDGE_RELEASE_KEY_FILE=C:/Users/you/keys/kmj-release-2026.pem
CODEBRIDGE_RELEASE_KID=kmj-release-2026
```

The key file must be outside the repository. Log in to GitHub CLI once
(`gh auth login`) so the script can check CI and open the PR for you.

## Every release

```bash
npm run release
```

It fetches `main`, checks that all CI on that exact commit passed, picks the
next sequence number, asks **one** `y/N` question, signs with your key (the
existing `owner-sign-stable-20261116.sh`), and opens a PR that adds only
`releases/stable/<commit>/release-manifest.{json,sig}`.

Then: wait for the green check on the PR, compare `MANIFEST_SHA256` in the PR
with what the script printed, and **merge**. The generic
`.github/workflows/publish-signed-stable.yml` rebuilds the archive from Git,
re-checks every value against the signed manifest and creates the GitHub
release `codebridge-stable-seq<N>-<sha8>`. It never overwrites a release.

Check any release folder locally:

```bash
npm run release:check -- <40-hex revision>
```

## On KMJ-elite: one command, no per-release scripts

Publishing to the origin, rolling the signed latest feed and the gateway
cutover used to need three copied scripts per sequence. They are replaced by
the sequence-agnostic `scripts/production/owner_elite_release.py`. Nothing is
pinned per release: sequence, version, archive and hashes are read from the
owner-signed manifest, verified with the root-owned trust file **and** the
pinned owner SPKI.

After the metadata PR is merged (the owner `Get-FileHash` of the manifest is the
release approval), run as root on KMJ-elite, with that same hash:

```bash
python3 -I owner_elite_release.py <40-hex revision> --manifest-sha256 <hash>              # dry run, writes nothing
python3 -I owner_elite_release.py <40-hex revision> --manifest-sha256 <hash> \
        --apply --confirm-no-active-jobs
```

`--manifest-sha256` is mandatory and must equal the signed manifest bytes on
`main`; a mismatch stops everything. Steps run in order and stop at the first
failure; each can be re-run alone with `--step publish|feed|cutover`:

1. **publish**: immutable `stable/<rev>/` on the static origin, never overwritten;
   the sequence must be higher than every published release.
2. **feed**: runs the existing, hash-pinned feed roller.
3. **cutover**: waits (up to 15 min) for the signed updater to install the
   runtime, then writes a new root-owned gateway override and restarts. The new
   catalog must be a **superset of the live catalog** (no hand-kept tool list),
   every critical schema must be present and the reported commit must equal the
   revision. Any failure removes only the new override and restores the previous
   runtime. Re-running after success reports `ALREADY_LIVE_UNCHANGED`.

Still separate and owner-run: signing (offline key), dispatching the hosted
smoke, and anything that is not a signed release. The script never touches keys,
the updater, the agent, Nginx or source repositories, and has no arbitrary path,
URL or shell argument.

## Fully automatic on KMJ-elite (one-time owner install)

After a one-time root install, KMJ-elite applies every owner-signed release by
itself. A release then needs only two owner actions: `npm run release` on the
signing PC, and approving its metadata PR. The **signature plus that protected
PR approval are the release approval**; the timer never signs and holds no key.

Every 10 minutes `kmj-codebridge-auto-release.timer` runs
`owner_elite_auto_release.py`, which applies **one** release per tick: the lowest
sequence above the live gateway sequence, via the same
`owner_elite_release.py` steps (publish, feed, cutover). Safety rails:

- **Kill switch:** `touch /etc/kmj-codebridge-release/auto-release.disabled`
  stops everything at once (both the unit condition and the script honour it).
  `systemctl disable --now kmj-codebridge-auto-release.timer` also works.
- **No automatic retry after a cutover attempt.** The release is recorded as
  attempted _before_ the restart; a failed or rolled-back release (or a crash)
  is never retried automatically. The owner clears it in
  `/var/lib/kmj-codebridge-release/auto-release-state.json`.
- **Cooldown** of 30 minutes between successful cutovers; the tick never waits
  for the signed updater (it simply retries on the next tick).
- Same cutover guarantees as the manual command: catalog superset, critical
  schemas, exact commit, rollback on any failure.
- Root/KMJ-elite only, no arguments, URLs or paths from outside; the three
  scripts are installed hash-pinned and the timer refuses a changed copy.

Install (dry run first; `--apply` needs the standing-consent flag):

```bash
python3 -I owner_install_elite_auto_release.py
python3 -I owner_install_elite_auto_release.py --apply --confirm-unattended-release-owner-go
```

It installs only the scripts, the service and the timer, and removes exactly
what it created if any step fails.

## Previous per-sequence scripts

The older `owner_publish_seq*`, `owner_activate_signed*` and `owner_promote_*`
scripts remain for history and rollback reference only.

## Development on KMJ-elite: separate `kmj-codebridge` agent

`scripts/setup-codebridge-dev-agent.sh` (root, once) adds a second CodeBridge
agent next to the Main Platform one. Dry-run by default; `--apply` is required to
change anything.

- Runs from the signed runtime `/opt/kmj-codebridge-stable/current` (readable by
  unprivileged users); the root-only legacy `/opt/kmj-codebridge-agent` is never used.
- Runs only on host `kmj-elite`, as the unprivileged `kmjdev` system user (it
  refuses a root service user).
- Clones the public repository over HTTPS into
  `/srv/kmj-codebridge-dev/kmj-codebridge`, a dedicated checkout (no deploy key, no
  token); an existing checkout elsewhere is never reused or modified. A remote URL
  is never printed because it can embed credentials.
- Pairing needs one owner browser approval (the script prints the code); the
  device credential is written only to `/etc/kmj-codebridge-dev/agent.json`
  (0600).
- Project profiles are the fixed `node-standard` presets (`npm ci`, test, check,
  build, lint). No gates, no freeform commands.
- Hardened systemd unit (`NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome`), writable only in the project root and its state directory. It
  never touches the Main Platform agent, unit, config or checkout, and the live
  gateway/runtime under `/opt` stay read-only to it.

Status: the script and its static tests are reviewed source only. It is **not**
proven on the live host until the owner runs it and a receipt is read back.
