# CodeBridge Moli fast browser lane (opt-in)

**Scope:** anonymous read-only probe of only https://kmjtechno.com/, /products and /login.
CodeBridge tool: `browser_fast_probe({device,project,target:'kmj_public',requestKey})`.
Permission: authorized writable `kmj-main-platform` project + normal execute entitlement.
Runs via existing bounded JobRunner, one agent slot; no added shell, arbitrary URL or model inference.

## How it works

1. CodeBridge starts its release-owned `scripts/browser-moli-fast.mjs` with fixed target and private receipt directory.
2. Moli v1.1.18 is allowed only when a pinned local executable exists at `/opt/kmj-codebridge-tools/moli/v1.1.18/bin/moli` (Windows: ProgramData/ KMJ / CodeBridge / moli / v1.1.18 / moli.exe).
3. Each public route is fetched with `moli fetch --block-private-networks --disable-subframes --dump json --wait-selector body --timeout 12000`.
4. A response counts as `EXTRACTION_PASS` only with verified same final URL, HTTP 200, and nonempty HTML. Hash/length and timing are returned; page text, cookies and JS are **not** returned.
5. Missing Moli or failed extraction starts the existing Chrome full public QA with nine screenshot hashes. Only Chrome's real QA PASS becomes `CHROME_QA_PASS`.
6. Otherwise the job is FAIL with safe error code. No silent success or downgrade of the existing browser_qa_start / browser_qa_receipt contract.

## Install (separate explicit operator-controlled action)

- After review and exact-SHA CI: `sudo bash scripts/install-moli-fast-lane.sh` on approved KMJ-elite Linux x86_64. It downloads *only* official Moli v1.1.18 Linux tarball, SHA-256 `59715fbdb2b016bb9136e1edb59a2a195c0f98459fd06739e17edc62da6a48b1`, refuses symlink/overwrite and checks --version.
- The Moli binary is optional, never autoinstalled by an AI chat or MCP call. Installing binary alone does not update CodeBridge gateway/agent or expose the new tool.
- The Windows binary has independent asset checksum and must be separately pinned and approved; Linux shell installer does not run on Windows.
- Runtime release needs signed/staged CodeBridge update with rollback proof, exact head CI and connected clients refresh. Do not run unreleased scripts on production.

## Security / performance criteria

- Fixed URLs only; no cookies, credentials, arbitrary JavaScript, CDP debug port or private network access; ephemeral HOME/cache.
- Max output 1 MiB and 14s per Moli page; large/slow/incompatible response uses Chrome QA fallback; raw HTML never written to receipt.
- Existing Chrome QA is authoritative for screenshots, accessibility/layout proof and full browser correctness. Moli extraction is not visual QA.
- Compare median elapsed, CPU/memory and semantic correctness on same public pages before making a faster-engine default claim.
- If `MOLI_NOT_INSTALLED`, skip Moli install while fixing CodeBridge worker/CI; shipping source isn't proof of a running worker.

## Release gates

`npm run check`, `npm test`, `npm run scan:secrets`, `node --test tests/browser-moli-fast.test.js`, exact GitHub PR-head CI, signed agent updater + rollback, and live `browser_fast_probe` evidence.
Never claim deployed unless a fresh runtime advertises the tool and an actual job returns a verified result.
