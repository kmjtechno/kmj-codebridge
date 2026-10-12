# Zero-paid-API optional offline AI inference (native CodeBridge)

`local_model_status({device,project})` checks **only** `http://127.0.0.1:11434/api/tags` on the authorized device. The status reports whether the owner-installed Ollama service and locally installed models are ready. No runtime/model download, cloud discovery, API key, paid provider, remote URL or gateway configuration is needed.

`local_model_generate({device,project,model,prompt,maxTokens,timeoutSeconds,localProcessingApproved:true})` runs one explicit inference with the **already installed model** through Ollama's local loopback API. The agent checks that the model name appears in the installed-model list before sending any prompt. The request is bounded to 4,096 input characters, 16–512 predicted tokens, 5–90 seconds, one active local request per agent, and response-size limits. `stream:false` and `keep_alive:0` request a model unload after inference; the runtime must independently confirm actual memory reclamation. No remote URL, local process spawn, model pull or external paid fallback exists, including on error. Response is untrusted text: it never runs shell commands or edits files on its own.

**Install separately by choice:** obtain an approved Ollama binary/runtime and a compatible licensed open-weight model while online, test model locally and turn off internet to verify. CodeBridge never auto-installs models, changes firewall bindings, or grants a chat access to private source. The Ollama endpoint **must remain bound to loopback only**; exposing it to the LAN or WAN defeats the isolation model. For secure private source, operator approval and device/local-model trust are still essential.

Use tiny quantized models for low RAM and escalate only when needed. CPU/GPU resources and electricity cost still exist, and this does not increase ChatGPT, Claude, ModelFabric or licensed CodeBridge job concurrency. No automatic cross-provider failover or autonomous coding worker is claimed. A future ModelFabric adapter can call this tool when other approved free providers are unavailable, but explicit authorization and policy are required first.

## Validation

`npm run check && npm test` validates formatting, project permission checks and local loopback-only stub inference. CI mocks the local runtime; a passing test does **not** prove that a machine already has Ollama installed. Actual owner hardware must separately verify local inference and resource usage. This feature works without third-party CI or paid API accounts.


## Multiple local Ollama instances / KMJ P720

An authorized P720 inference gate verified **real local generation** on 2026-10-12:
`qwen2.5-coder:7b` on loopback port `11435` (33.33 eval tokens/s) and
`qwen3:4b` on loopback port `11436` (44.37 eval tokens/s), both Ollama
0.40.1, with GPU-offload telemetry (not physical GPU identity proof).
The original local-model client checked only standard Ollama port `11434`.

The agent now probes bounded loopback ports `11434`, `11435`, `11436`
concurrently. It reads each runtime's installed model tags, only generates on
the port that advertises the **exact requested installed model**, uses one
model generation at a time per CodeBridge agent and unloads on completion via
`keep_alive:0`. No external hostname, URL, DNS lookup, proxy, model pull,
or paid fallback. Agent factories can pass a fixed `port` or bounded `ports`
array for self-hosted installations and integration tests. Chats cannot set
an arbitrary destination port.

Multiple model runtimes **do not increase licensed concurrent task slots**;
the owner approves the local model before prompts are processed. These source
changes require a versioned agent upgrade; merging code does not update the
running P720 agent.
