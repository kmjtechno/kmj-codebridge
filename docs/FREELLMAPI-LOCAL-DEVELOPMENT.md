# FreeLLMAPI adapter — local developer use only

CodeBridge can connect to the **loopback** FreeLLMAPI gateway when installed on the **same device** (`127.0.0.1:31415` by default).

**This is not a production inference SLA or an enterprise free-inference guarantee.** Upstream FreeLLMAPI documents that it is intended for single-user experimentation. Its local proxy can forward prompts or repository text to enabled cloud providers and custom endpoints, which may charge the account owner. Do not expose this router publicly or send customer/private code without approval and a provider-specific data handling review.

## Safe operator configuration

- Configure `CODEBRIDGE_FREELLMAPI_KEY` as a _device-local secret_, not in Git, a chat prompt, process arguments, an MCP URL, or a dashboard screenshot.
- Explicitly set `CODEBRIDGE_FREELLMAPI_APPROVED_FREE_CHAINS` to a comma-separated **owner-reviewed** subset advertised by the running `/v1/models` API. Example names are `auto:code,auto:default`; these are not presumed to exist on every router.
- In FreeLLMAPI, independently verify that every eligible upstream/chain is free for **your account**, within its ToS, and does not silently fall back to paid providers. The allowlist denotes operator approval, **not billing proof**. Only owner-vetted chains should be listed.
- `freellmapi_status` is a read-only discovery tool; `freellmapi_generate` requires both `localProcessingApproved: true` (contact the router) and `upstreamCloudApproved: true` (the router can transmit content to a remote provider), plus an owner-allowed and currently advertised chain.
- If consent, key, chain discovery or allowlist is missing, generation fails closed. 429 retries can only move to another advertised and approved chain, never an unlisted model, and not on ambiguous timeouts.

**Model identity warning:** FreeLLMAPI's Anthropic-compatible `/v1/messages` surface can route Claude-family aliases to other underlying models. Neither `claude-sonnet` nor a `task: reasoning` selection proves that Anthropic Claude generated the output. CodeBridge reports `paidInference: null`, `cloudFallback: null` and `actualUpstreamModel: null` until provider-and-cost provenance is authenticated. The adapter does **not** switch the underlying model powering ChatGPT or Claude's own hosted chat interface.

Do not deploy this adapter as a paid commercial service based only on the router's reported "free" chains; production needs independent provider contracts, billing admission, privacy isolation and availability evidence.
