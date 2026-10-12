# P720 Local LLM First — activation and GPU evidence

**Priority P0 (owner direction, 2026-10-12):** before broad dashboard, GUI and release factory work, make the already-installed P720 Ollama models actually usable by supported AI clients through the **authorized KMJ CodeBridge MCP connection**. Reduce paid/cloud token consumption where safe; never claim that a small local model can replace a hosted model's capabilities in every task.

## What works and what is blocked

- Real local inference gate `p720_inference` has passed on authorized `kmj-p720-desktop-k3ahhem` using `qwen2.5-coder:7b` on `127.0.0.1:11435` and `qwen3:4b` on `127.0.0.1:11436`. That gate **cannot accept an arbitrary chat prompt**.
- Source `src/tools.js` already defines `local_model_status`, `local_model_generate`, and `autopilot_local_draft`. `src/local-model.js` checks exact installed models on bounded loopback ports, requires explicit local-processing approval for the prompt tool, rejects oversized prompts, and requests unload with `keep_alive:0`.
- **Known blocker:** the installed ChatGPT CodeBridge integration currently does **not** expose these tool names in its captured callable schema. The schema of `fast_read_batch` also does not include `local_model_status` although the newer source's `FAST_READ_TOOLS` array does. Source definitions alone are not proof that a client can invoke the tool.
- On the P720, CodeBridge `supervisor_status`, `supervisor_device_status`, and update-status checks returned `SUPERVISOR_UNAVAILABLE`. An interactive/Windows task agent may be present instead of a supervisor service. Do **not** restart it blindly, rerun enrollment, replace its credential, or disrupt the separately authorized CineCore agent.
- This source PR adds read-only Windows GPU inventory evidence to the existing `p720_inference` gate: fixed-path `nvidia-smi` first, then fixed-path PowerShell Windows VideoController fallback. A GPU name is not evidence of exact model-to-GPU attribution; `size_vram` is not the physical adapter name. A queried NVIDIA compute process may corroborate GPU activity, not distinguish two concurrently active Ollama instances.
- **Existing models are not auto-downloaded.** The tool never enables remote Ollama bindings. Physical GPU identification and model unload/memory-release require independently measured live evidence.

## Required Claude implementation and verification order

1. Check exact `main`, the P720 agent binary/runtime version, installed ChatGPT/Claude MCP tool inventory and gateway's exposed `tools/list` through *real authorized OAuth*, then compare it to `src/tools.js`. Produce a sanitized 4-column report: `defined / hosted-listed / client-visible / callable on P720` for each local-model tool.
2. If hosted gateway publication is stale, create a versioned release/change for **MCP tool schema publication**. If the ChatGPT-installed plugin/catalog is stale, update the owned plugin through its supported publishing workflow and require its normal reconnect or user approval. Do not work around MCP allowlists or submit arbitrary tool names to an unrelated tool.
3. Safely update the existing P720 CodeBridge agent with an owner-approved, signed/pinned release and rollback to the previous healthy version; preserve its enrollment, state directory and CineCore device. Confirm local `local_model_status` and `local_model_generate` against the live P720 agent **through the MCP client**, not only a Node unit test.
4. Validate actual model identity and GPU inventory by running `p720_inference` after the current PR's GPU enhancement is deployed or tested in a temporary hash-guarded authorized checkout. Run `p720_ai_tests` too. Compare physical adapter evidence with Ollama `size_vram` and, if supported, NVIDIA Ollama compute-process presence. Do not infer a specific model GPU if the mapping cannot be independently verified.
5. With explicit owner approval for each project, use `qwen3:4b` for bounded low-risk summaries/triage and `qwen2.5-coder:7b` for local coding suggestions. Return only untrusted text suggestions to the project-scoped, hash-guarded edit/build/test workflow. Test failure, 90 s timeout, model missing, wrong permissions, two-client race, timeout cleanup, no external network call, and accurate unload evidence.
6. For genuine **minimum cloud AI credits**, integrate a separate local-first worker/ModelFabric routing loop for tasks where Claude/ChatGPT isn't available: queue task → pick installed model → generate untrusted patch proposal → human/policy-gated edit → real tests. **Do not mislabel CodeBridge's Ollama MCP tool as a switch of Claude's or ChatGPT's underlying inference backend.**
7. Once verified, implement optional model-specific routing with per-project policy, measured resource budgets, no unexpected paid fallback, and display usage truthfully in Main Platform. Do not block unrelated safe PR work while waiting on a hosted provider-side connector refresh.

## Acceptance evidence (not optional)

- CodeBridge MCP `tools/list` and real client call show `local_model_status`, `local_model_generate`; report exact observed model list, permission and approval results. An installed schema missing either tool is **BLOCKED**.
- Both models produce visible, nonempty code/triage outputs through authorized MCP calls (not merely a preconfigured gate). Show measured elapsed time, evaluated tokens where reported and redacted error codes.
- `p720_inference` returns physical GPU inventory `gpuHardware.verification` with name/driver/memory or `GPU_IDENTITY_NOT_VERIFIED`, plus the per-model Ollama offload values. This does not automatically imply per-model physical GPU mapping.
- No extra subscriptions, network model pulls, leaked source/keys, unrestricted shell, unexpected Windows service stop or production deployment.
- Give user `PR | exact head SHA | device | tests / MCP client calls PASS/FAIL | GPU evidence | rollout / rollback | blocker`. Partial simulation is never described as live acceptance.

**Reconciliation:** Keep `kmj-main-platform` #379 → #381 → #382 and `kmj-codebridge` #293 separately safe. Do not overwrite other agents' branches. New local-LLM publishing/activation work takes priority over general M0–M3 scope.
