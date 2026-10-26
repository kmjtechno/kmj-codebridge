# Optional Mozilla AI llamafile + whisperfile adapters (source-only)

**Source integration only. No runtime install, MCP tool, model download, background
process, automatic failover or production change is shipped by this PR.**
This work is intentionally deferred behind KMJ Main Platform P520 onboarding.

## What we actually use

- [Mozilla AI llamafile](https://github.com/mozilla-ai/llamafile)
  (reviewed release: **v0.10.6**, 2026-09-15): the documented local
  OpenAI-compatible **GET /v1/models** and **POST /v1/chat/completions**.
  `createLlamafileLocalBackend` in `src/llamafile-backend.js` is a
  disabled-by-default, single-flight, bounded **draft-text** adapter. The
  backend does **not** execute model-suggested tool calls or write code.
- [whisperfile HTTP server](https://github.com/mozilla-ai/llamafile/blob/main/docs/whisperfile/server.md):
  documented **GET /health**, **POST /inference** for owner-provided WAV
  bytes. `createWhisperfileLocalBackend` in
  `src/whisperfile-backend.js` is a separate disabled-by-default source
  adapter for **future Kristi speech input**, not microphone capture, voice
  playback, or a currently working Kristi feature.

Both factories use **Node's direct HTTP client fixed to 127.0.0.1**:
the owner-local configurable ports default to 8080 (LLM) and 8081
(voice), which must be different if both are tested. Their ports are
**never taken from MCP/chat payloads**. Both reject non-200 responses,
redirects, oversized bodies and invalid responses, and require
`localProcessingApproved: true` for each generation/transcription.
The adapters never call remote URLs, proxy settings or DNS.

## Non-negotiable privacy and resource policy

- They are **not registered in `src/tools.js`**, the production gateway,
  `ModelFabric`, `smart-model-router`, the agent startup path, or the
  current **Ollama local-model fallback**. Importing alone starts nothing.
- **Loopback is not service identity verification.** An untrusted service
  listening at the chosen local port can proxy requests to cloud or spend
  money. The adapters therefore return
  `backendIdentityVerified: false` and do **not** attest zero billing.
  Operator must verify binary hashes, listener identity, actual bind
  address, OS process provenance and network isolation separately.
- Never send secrets, proprietary project source or microphone content before
  that check. All model output is untrusted; no shell, patches, PRs, tool
  calls, payment actions or privileged I/O are triggered from generated text.
- LLM: bounded model catalog, owner approval, max **4096 prompt chars**,
  **512 output tokens**, **90s timeout**, **64 KiB response**, one request
  in flight. Only an exact **already listed** model ID is accepted.
- Voice: only **caller-supplied WAV Buffer**, RIFF/WAVE header sanity check,
  max **1 MiB** input, **4096 chars** output and **60s** timeout, one
  request in flight. No local file read, recording or persistent storage.
  These basic header checks are not a complete media decoder or sandbox;
  hardened audio parsing/isolation needs separate acceptance.
- Optional locally running inference consumes CPU/GPU/RAM and is **not**
  necessarily faster or cheaper than our already installed free LLM path.
  P520 calibration hardware QA (projector/camera workloads) takes priority.
- Mozilla llamafile **project code** is Apache-2.0 licensed; linked runtime
  model weights can have **different commercial/distribution licenses**.
  We **do not vendor** upstream executable, model, weights, GPU library or
  Whisper models. Reuse APIs with attribution; do not copy their code.

## When to implement end-to-end (separate reviewed PR)

1. **P0 first:** guarded KMJ Main Platform release/live
   `GET /api/codebridge/v1/device-enrollments/readiness` must return
   HTTP 200 + `{"pairing_config":"ready","protocol":2}`.
   P520 `kmj-homeoffice-desktop-5fvjmet` must complete independent
   authorized `connection_overview = READY` and an authenticated agent
   heartbeat. **Never bypass browser owner approval, release manifest
   protections or project allowlists.** P720 remains offline.
2. Operator inventories **actual P520** CPU/RAM/GPU, Calibration Pro
   projector/camera load, and available disk. For stress tests, use an
   isolated owner-consented hardware window and do **not** silently enable
   inference while calibration is running.
3. Explicitly choose & verify a licensed compatible **tiny GGUF model**,
   locally installed Mozilla binary and requested localhost server.
   Windows bundled executables >4 GiB are unsupported; use an external
   GGUF with appropriate small runtime. Secure all listeners to loopback
   and use OS process identity verification. Check binary signature/digest
   and offline/no-cloud network behavior independently.
4. Separate staging tests: Windows and Linux native runtime compatibility,
   same-task local latency p50/p95, peak resident RAM/VRAM, warmup,
   concurrency, transcription accuracy for Hindi and English, failure and
   crash recovery, and zero unsolicited outside connections.
5. Only after measured benefit and owner sign-off: enable **optional**
   adapter routing **per device** behind an explicit default-off feature
   switch, trusted service identity and resource/cost admission. Never
   replace the existing free cloud or Ollama default. Introduce public
   MCP tools and Kristi UI only in a separately reviewed/passed release.

## Minimal developer-only contract

```js
import { createLlamafileLocalBackend } from "../src/llamafile-backend.js";
import { createWhisperfileLocalBackend } from "../src/whisperfile-backend.js";

const inference = createLlamafileLocalBackend(); // enabled:false
const voice = createWhisperfileLocalBackend(); // enabled:false
console.log(await inference.status(), await voice.status());
// Neither call opens a socket or initiates model downloads.
```

Unit regression checks: `node --test tests/llamafile-backend.test.js
tests/whisperfile-backend.test.js`. CI uses **stub servers on 127.0.0.1**.
Successful CI does not mean hardware support or a live P520 installation.
