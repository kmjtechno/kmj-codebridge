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

## Previous per-sequence scripts

The older `owner_publish_seq*`, `owner_activate_signed*` and `owner_promote_*`
scripts remain for history and rollback reference only.
