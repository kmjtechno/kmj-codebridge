# OpenAI public directory release gate

This checklist tracks facts required before KMJ CodeBridge can be submitted to the
universal ChatGPT/Codex Plugins Directory. Source/package tests are necessary but do
not prove public availability.

## Package gate

- [x] Portable Agent Plugins manifest and canonical skill.
- [x] Public listing text within documented submission limits.
- [x] HTTPS website, support, privacy and terms URLs declared.
- [x] Five positive and three negative MCP review cases declared.
- [x] Commerce declaration and release notes declared.
- [x] Credential scan and OpenAI package contract enforced in CI.
- [ ] Reviewer-accessible demo recording URL added after the real flows are recorded.

## Hosted MCP gate

- [ ] Stable production HTTPS `/mcp` endpoint on an approved hostname.
- [ ] TLS/reverse-proxy streaming behavior verified against the deployed endpoint.
- [ ] OAuth 2.1 authorization server available with PKCE S256 and supported OpenAI
      client registration/identification.
- [ ] Protected-resource metadata, authorization-server metadata and `resource`
      propagation verified end to end.
- [ ] Dedicated reviewer account and sample tenant/device/project provisioned without
      MFA, magic-link or private-network dependencies.
- [ ] All five positive and three negative review cases executed against the reviewer
      account and recorded.
- [ ] MCP Inspector passes initialize, tools/list, representative calls, auth failure,
      insufficient-scope and error-path checks.
- [ ] Real ChatGPT installed-plugin session passes the representative review flows.
- [ ] Real Claude Code session passes against the same hosted gateway.
- [ ] Real Claude.ai/Desktop custom connector passes after the same OAuth service is
      available.

## OpenAI submission gate

- [ ] KMJ TECHNO business identity verified in the owning OpenAI Platform organization.
- [ ] Plugin ZIP built with the final production MCP URL.
- [ ] Plugin draft uploaded to the submission portal.
- [ ] MCP domain-verification challenge hosted at the exact URL/token supplied by the
      portal.
- [ ] Current OpenAI MCP tool scan succeeds with no blocking findings.
- [ ] Reviewer credentials entered only in the secure dashboard review form.
- [ ] Demo recording URL and country availability completed.
- [ ] Policy attestations reviewed by an authorized owner and submitted.
- [ ] OpenAI review approved.
- [ ] Authorized owner selects **Publish plugin** after approval.

Do not mark a hosted, review or publication item complete from source tests alone.
