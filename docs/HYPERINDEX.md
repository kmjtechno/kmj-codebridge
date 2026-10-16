# HyperIndex backend foundation

`HyperIndex(ProjectFiles, privateStateDirectory)` is an opt-in local SQLite FTS5
trigram backend. Three MCP tools expose status, explicit build and search with
safe fallback. They are source-only and not enabled in production. Existing
`search_code`, repository maps and context packs remain unchanged.

State must be a real private directory outside the project. Database files must
be private, singly linked, and owned by the running account. Project identity is
bound to the canonical root. Reusing one database for another root fails closed.
The device/tenant layer must supply a distinct state directory per grant; this
module does not authenticate callers. The same OS account is trusted.

Each search reconciles the policy-visible bounded tree (2,000 visited entries,
8 MiB text, depth 12). It hashes current files and updates only changed database
rows in a transaction, dropping deleted or inaccessible entries. Recognized
credential values are redacted before persistence and again before delivery;
this heuristic does not identify every possible secret. Private contents stay
on device. Results are re-read through ProjectFiles and checked against the
reconciled SHA before snippets are returned. Concurrent changes can produce
partial results, never an assertion of an atomic whole-project snapshot.
`truncated` and coverage counters describe limits. Unsupported short/non-ASCII
FTS queries use bounded table candidates with the same exact substring check.

SQLite has a 64 MiB page limit and memory journaling; failed transactions roll
back. Corrupt databases fail closed. Lexical fallback handles absent, unsafe or corrupt indexes without deleting
state. Automatic repair, watcher generations, regex isolation, symbols and
change feeds are still pending. Do not treat this foundation as the completed HyperIndex MVP.
No additional service, native package, watcher or external search provider is
installed. Node 24's bundled SQLite must support FTS5/trigram.

Run `node --test tests/hyperindex.test.js` and
`node scripts/benchmark-hyperindex.js <project-root>` from this checkout.
The benchmark compares the same query/data, rejects differing matches, and
reports sample counts and p50/p95/p99/max. It measures local synchronous calls,
not authenticated remote latency. One query is not a representative recall
qualification. Full reconciliation is intentional until reliable invalidation
is implemented; no large speedup is claimed.

Windows activation fails closed with `INDEX_WINDOWS_ACL_UNVERIFIED`: POSIX
mode bits do not establish a private Windows ACL. Windows tests verify this
refusal; the POSIX functional suite is explicitly skipped there. A Windows
ACL adapter is required before enabling persistent indexing on Windows.

`hyperindex_build` requires execute permission and creates private index state
only after existing entitlement, device and project authorization. Search
requires read permission and creates no index when missing. Existing indexes
are reconciled on search. Status is presence-only, not an integrity proof.
