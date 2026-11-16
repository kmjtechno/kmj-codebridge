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

## Still owner-run (unchanged)

Publishing to the kmjtechno.com origin, rolling the signed latest feed and
gateway promotion still use the existing owner scripts on KMJ-elite. Nothing
here deploys, restarts or changes production.
