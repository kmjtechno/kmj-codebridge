# Private Main Platform native Ubuntu evidence

The trusted CodeBridge verifier executes private Main Platform assertions in a
credential-free disposable `kmjci` sandbox. This document describes execution
coverage, not a production approval or a fabricated GitHub check result.

Authority inspected: Main Platform PR322 head
`8ebbb6f1999309875b6f6b0c6d25c21847fff3ff`, specifically
`kmj-main-platform-ci.yml`, `platform-ci.yml`, `codebridge-contract.yml`,
`codebridge-device-pairing-ci.yml`, `codebridge-oauth-link-ci.yml`,
`verify.yml`, and their referenced platform/Python verification scripts.

| Assertions                                                                                    | Native gates                                                                                                     |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| PHP supported version range and Node22 platform runtime                                       | platform_runtime                                                                                                 |
| Test application key, isolated SQLite migrations, tracked PHP syntax                          | php_key_generate, php_migrations, php_syntax                                                                     |
| Frontend formatting/lint/build/TypeScript                                                     | fmt_lint, frontend_build, typescript                                                                             |
| Clear test config, Pint, PHPStan, full PHP tests                                              | php_config_clear, php_format, php_static_analysis, php_tests                                                     |
| Python3.11+ and controller dependency imports                                                 | foundation_python_runtime                                                                                        |
| Controller compilation and existing worker/recovery tests                                     | foundation_compile, foundation_workers                                                                           |
| Existing staging browser-QA tests and locked policy assertions                                | foundation_browser_qa, foundation_policy                                                                         |
| Existing backup/recovery and architecture assertions                                          | foundation_backup, foundation_architecture, foundation_module_architecture                                       |
| Exact head/base delivery progress, public surface, free router, contracts, runtime provenance | foundation_delivery, foundation_public_surface, foundation_free_router, foundation_contracts, foundation_runtime |
| Rust formatting, offline locked Rust tests, KSLP digests                                      | rust_format, rust_tests, kslp_contract                                                                           |
| PHP lease syntax, activation proof, renewal, Node24 consumer verification                     | lease_encoder_syntax, activation_proof, renewal, license_runtime, node_lease_interop                             |
| PostgreSQL17 concurrency, explicit PASS marker and rejection of SKIP                          | postgres_concurrency                                                                                             |

No missing prerequisite is skipped. Absent Node22/24, Python modules, Rust
compiler/crates, PHP extensions, or PostgreSQL17 fails the corresponding gate.
Approved runtime/cache preparation is separate; the worker never downloads
packages, accesses production databases, or consumes paid model APIs.

The isolated Git database is initialized with empty templates and disabled
system/global Git configuration. Only objects reachable from the candidate and
current source baseline are packed into it; source credentials, remote settings,
and hooks are not copied. The trusted parent records candidate/base SHAs,
consumer SHA, consumer verifier digest, gate markers, and the private log digest.
Consumer files come directly from that immutable CodeBridge commit. These fields
must match the reviewed commits and actual required CI before acceptance.

Public CodeBridge Windows CI remains a separate result at its actual tested
CodeBridge commit. It covers the public Node runtime/client assertions and does
not claim that private PHP/Rust/Main Platform code ran on Windows. Existing
Windows skips remain visible in that repository's evidence.

The private Owner release policy currently specifies GitHub-hosted execution.
Accepting equivalent native Ubuntu evidence requires an explicitly reviewed
execution-location amendment. Required assertions, production browser QA,
authenticated Owner checks, signing controls, audit, and deployment safeguards
remain mandatory. Existing GitHub failures are retained; this verifier does not
submit green statuses or modify repository protections.
