# Enterprise engineering intelligence — November 28, 2026

This extends the existing CodeBridge execution, licensing, tenant, project,
worktree and review boundaries. It adds no new service, paid provider, host
shell grant, automatic upstream installation or model source transfer.

## Implemented in this candidate

- HyperIndex multi-query live search: up to six distinct literal terms in one
  policy-checked traversal, 1–16 results per term (default 10), bounded scan
  coverage and no persistent index creation. Compatible with Windows fallback;
  the persistent Windows SQLite index remains disabled until ACL verification.
- Six additional reviewed engineering skill recipes: architecture impact,
  native debugging, test selection, performance observability, source-driven
  engineering and safe large refactoring. These are advisory workflows, not
  proof that the corresponding tools are installed or that inference ran.
- Compact IDE receipts: deduplicate repeated identical status markers, retain
  distinct status values within the receipt cap, and extract bounded numeric
  CTest, pytest and Cargo summaries from untrusted project output. Runner exit
  state is authoritative for execution; printed counts are not attestation.

## Selective upstream integration plan

| Reference | Decision | Required acceptance |
| --- | --- | --- |
| [ast-grep](https://github.com/ast-grep/ast-grep), [SCIP](https://github.com/scip-code/scip) | Pilot structural search and symbol graph in existing HyperIndex | Pin reviewed toolchain; compare against compiler-resolved definitions and references; isolate generated and denied files |
| [Codebase Index](https://github.com/denfry/codebase-index), [Ripwire](https://github.com/redhat-et/ripwire) | Evaluate incremental indexing and impact analysis; do not install another MCP server by default | Local benchmark on C++/Qt, PHP, Python and Rust; freshness and negative scope tests |
| [RTK](https://github.com/rtk-ai/rtk) | Prefer KMJ-owned typed compact output, no blind shell wrapper | Compare bytes, error preservation and full-log recoverability |
| [Debug Adapter Protocol](https://github.com/microsoft/debug-adapter-protocol) | Build scoped debugger adapter on existing IDE job engine | Explicit launch/attach permissions, pinned debugger binary, process lifecycle, bounded stacks and variables, real P520 break/step/cancel test |
| [pytest-testmon](https://github.com/tarpas/pytest-testmon) | Pilot affected-test prioritization, not mandatory-gate replacement | Validate dependency coverage, changes and false-negative fixtures; always run required CI |
| [OpenTelemetry](https://github.com/open-telemetry/opentelemetry-js) | Prefer bounded local latency spans first | No external exporter by default; measure p50/p95, payload bytes and internal round trips |
| [Symphony](https://github.com/openai/symphony), [Agent Client Protocol](https://github.com/agentclientprotocol/agent-client-protocol) | Adapt existing lease-based orchestration and client interfaces rather than duplicate daemons | Prove authorized independent work, resource/entitlement limits and restart recovery |

These are research references only, not vendored dependencies or claims of
license clearance. Before adding any upstream executable, pin its reviewed
revision, verify its license and supply chain, use an explicitly authorized
isolated pilot and benchmark it against the current implementation.

## Release and speed evidence

Measure the same authenticated workload before/after on Elite and P520:
connector response time, bytes, project scans, internal request count, CPU,
RAM, exact-head correctness and failure preservation. The existing November 28
three-sample live baseline is Elite resume 931 ms median, P520 resume 1627 ms
median. Connector timing is not ChatGPT browser rendering or model latency.
Require complete exact-head CI, independent review and the existing signed
release/readback process. A merged implementation is not an active runtime.
