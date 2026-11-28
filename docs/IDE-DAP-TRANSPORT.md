# Scoped IDE debugger transport

This candidate adds a native, dependency-free DAP stdio protocol engine for
trusted local adapters. It is not a public MCP debugging endpoint and does
not start a debugger, attach to a process, read a user's variables or widen
an agent grant.

- Strict bounded Content-Length and UTF-8 JSON frames, including fragmented
  and batched frames.
- Correlated request/response IDs, bounded outstanding requests and event
  metadata, explicit timeouts and connection close instead of replay.
- Fixed debugger command catalogue. Arbitrary expression evaluation, process
  attach, variable mutation and adapter reverse requests are denied.
- Raw adapter response bodies remain internal; they must not be sent to chat
  before path validation, response schemas and secret redaction.

Next acceptance: use the existing isolated exact-head lane and a separately
approved, pinned debugger binary; implement trusted launch configuration,
process-tree cleanup and authenticated project-scoped debug session state.
Add bounded breakpoint, stack, variable and step controls with negative
scope tests. Prove the actual adapter on P520 and Linux. No package install,
network debugger, signed update or production mutation is part of this PR.

The tests use in-memory DAP frames. They establish protocol behavior only,
not functional native Qt debugging or physical hardware evidence.
