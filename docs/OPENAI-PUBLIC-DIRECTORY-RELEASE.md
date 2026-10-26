# OpenAI public Plugin Directory — release gate

**State:** PREPARE_ONLY. This document and the separate ZIP builder do **not** submit, approve, or publish KMJ CodeBridge. The private desktop package remains unchanged.

## Prepare a review ZIP

On an isolated, clean checkout with Node 24+, run:

```bash
node scripts/package-openai-directory.mjs --out /tmp/kmj-openai-review
npm run scan:secrets -- /tmp/kmj-openai-review/kmj-codebridge
unzip -l /tmp/kmj-openai-review/kmj-codebridge-openai-directory.zip
```

The builder copies the canonical KMJ assets, license, terms, privacy notice,
and onboarding skill. It substitutes the real hosted Streamable HTTP MCP
endpoint `https://kmjtechno.com/mcp` for local stdio and deliberately excludes
`.app.json`, App bindings, and local desktop executors. The SHA-256 digest
printed by the builder identifies the ZIP bytes. No tokens, test credentials,
reviewer passwords, or domain-verification challenges belong in source control.

## Hard release gates — fail closed

- **Code and CI:** green exact-head CI, dependency audit, and a reviewed,
  source-pinned change. Passing source CI alone is not a deployment pass.
- **Hosted production:** public OAuth discovery, scoped 401 challenge, actual
  browser OAuth success, current tool scan and accurate annotations. Verify
  authorization per account, project, device, read/write scope and tenant.
- **Parity:** `scripts/verify-public-mcp-catalog.mjs` must PASS; never suppress
  `MCP_CRITICAL_SCHEMA_DRIFT`. Fix the **deployed server contract** rather
  than weakening critical lease/fencing or workspace validation.
- **GitHub readiness:** hosted integration must complete a fresh successful
  authenticated or explicitly supported read-only GitHub probe. A failed
  `GITHUB_RATE_LIMIT` is not PASS. Do not hardcode or print GitHub tokens.
- **Owner QA:** on an authorized reviewer/demo account, verify five positive
  and three negative scenarios. Cross-tenant and secret access MUST be denied;
  user-file edits require approved guards and conflict detection. Remote Windows
  device pairing is explicit owner-approved; do not simulate online devices.
- **Publisher and legal:** verify KMJ TECHNO business identity and MCP domain
  in the OpenAI submission dashboard. Check that landing, support, privacy, and
  terms URLs work and match real data handling. Provide a reviewer-accessible
  demo account with sample data **through the secure portal**, not the ZIP.
- **Review:** provide a genuine walkthrough recording URL, current MCP scan
  and eight tested review cases. Resolve all blocking validator findings and
  policy attestations before clicking Submit for review.

## Publication

Use the official [submission portal](https://platform.openai.com/plugins)
and [submission guide](https://developers.openai.com/plugins/deploy/submission).
Upload the ZIP as a new remote-MCP submission, select the verified business,
connect and scan the production MCP URL, complete domain verification, attach
the real recording and secure demo login, and submit for OpenAI review.
**Publication is a separate action only after OpenAI approves the submission.**

This ZIP is intentionally different from the owner-only private plugin.
Never replace the installed local/desktop plugin with this public package
without a separate migration, smoke check and explicit user consent.

## Known unresolved evidence (26 October 2026)

- Hosted Deployment Smoke run 40288396075 reported
  `GITHUB_RATE_LIMIT` and `MCP_CRITICAL_SCHEMA_DRIFT`
  (`chat_workspace_open`).
- Source CI run 40300263169 succeeded at commit
  `822b20c884abbc328c999606dfe617dbc63b79ad`.
- These results are historical observations, **not** proof that later
  production deployment or public submission has passed.
