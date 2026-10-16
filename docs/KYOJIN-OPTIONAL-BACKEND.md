# Optional Kyojin local inference backend (source-only)

The MIT-licensed [Yamz-Labs/kyojin](https://github.com/Yamz-Labs/kyojin)
project provides an OpenAI-compatible local API with `GET /v1/models`
and `POST /v1/chat/completions`. Its published high-throughput benchmarks
are on AMD gfx1151 / 128 GB Strix Halo. They are **not** measured on KMJ's
Windows Lenovo P720 (two NVIDIA Quadro P4000 GPUs, 32 GB RAM).
Upstream ExLlamaV3 retains CUDA paths; Kyojin's tuned AMD serving stack and
95-106 GB model packs must not be assumed compatible with the P720.

`src/kyojin-backend.js` adds a dependency-free, local-only compatibility
adapter. This is a **source-level optional integration**, not an MCP tool,
installed local model, running server, hardware upgrade, deployed agent, or
automatic routing change.

## Security and operational contract

- Disabled by default: no server discovery or inference request occurs.
- Construct and enable only in **trusted device-owner configuration** after a
  supported Kyojin deployment and explicit opt-in. Port defaults to 8000;
  the port option is administrator-side configuration, never a chat/MCP input.
- Requests are confined to `127.0.0.1` using Node HTTP, with fixed paths.
  The adapter never follows redirects, uses DNS/proxies, downloads weights,
  starts processes, or executes tool calls.
- Model IDs must be discovered from the bounded local `/v1/models` catalog.
  Prompt length, output tokens, timeout, response size and concurrency are
  capped. Generation additionally requires `localProcessingApproved: true`.
- Loopback transport **does not attest server identity or billing**: a
  masquerading local proxy could itself contact a paid/cloud service. The
  response therefore reports `backendIdentityVerified: false` and
  `billingVerified: false`. Operators must independently inspect the
  service and model licenses before using sensitive code.
- All model output is **untrusted draft text**; it does not automatically
  edit projects, execute tools, open PRs, or consume autonomous task leases.
- No existing Ollama fallback, ModelFabric route, credentials, production
  gateway, P720 Windows supervisor or licensed feature is modified.

## Future guarded activation (separate change)

1. Identify a **compatible host** and inspect the running loopback server
   and model licensing; do not install the 95-106 GB packs on P720.
2. Enable the adapter in an authorized device-local context, prove
   `status()`, `generate()` and failure behavior using real metrics.
3. Measure first-token latency, throughput, memory and context accuracy
   against the existing Ollama/llama.cpp fallback **on the same host**.
4. Admit the backend to ModelFabric's already-existing free-cloud-first
   router only with verified identity, cost guard, explicit local approval
   and healthy capacity; no automatic cloud or paid fallback.
5. Validate client/tool discovery, full CI, rollback and agent runtime
   separately before claiming deployment.

## Basic local contract

```js
import { createKyojinLocalBackend } from "../src/kyojin-backend.js";

// Owner-controlled configuration only; never expose this knob to MCP chat.
const backend = createKyojinLocalBackend({ enabled: false });
console.log(await backend.status()); // disabled, zero HTTP calls

// On independently verified compatible local hardware only:
// const backend = createKyojinLocalBackend({ enabled: true, port: 8000 });
// const status = await backend.status();
// const result = await backend.generate({
//   model: status.models[0],
//   prompt: "Draft a unit test",
//   localProcessingApproved: true,
// });
```

Local safety regression tests: `node --test tests/kyojin-backend.test.js`.
The adapter is **not activated by importing the module**.
