# KMJ CodeBridge Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. User explicitly requested direct implementation and GitHub upload in this session.

**Goal:** Deliver a runnable developer-preview gateway, outbound device agent, scoped coding tools, durable jobs, entitlement verifier, plugin packaging and CI. Preserve the full commercial roadmap without representing future phases as shipped.

**Architecture:** A stateless Streamable HTTP MCP server forwards authorized tool calls to an authenticated outbound-polling agent. Administrator-owned configuration establishes users, devices and project roots; the model cannot grant itself access. The agent owns the filesystem and job journal. Main Platform integration consumes signed entitlements; no signing key is distributed.

**Tech Stack:** Node.js 24, official MCP SDK 1.31.0, Zod, node:test, standard crypto/fs/process APIs.

**Spec:** ../../specs/KMJ-CodeBridge-Roadmap.yaml

## Global Constraints
- Product name KMJ CodeBridge; one plugin; Main Platform remains commercial authority.
- No production writes, external spending or invented public endpoint.
- Preserve current repository history; publish verified code with honest limitations.
- Native Rust agent, OAuth onboarding, actual billing integration, signed installers and public hosting are later verified deliverables, not fictional features.

## Review Focus
- Wrong-tenant devices and returned job identifiers must not cross authorization boundaries.
- Symlink paths, secret files, malformed inputs and non-text/oversize files must fail safely.
- Retries and restarts must never blindly re-execute non-idempotent jobs.
- Bad signatures, wrong device bindings and time/expiry errors must reject paid actions.
- Disconnects, cancellation, process output and queue growth must remain bounded.

## Task 1: Scoped filesystem and configuration
Files: src/errors.js, src/policy.js, src/config.js; tests/policy.test.js.
Produces: ProjectFiles(root).read(path), preview(path, content, expectedHash), write(...), search(query).
- [ ] Write tests for traversal, symlinks, secret patterns, conflict detection, UTF-8 and bounds.
- [ ] Run node --test tests/policy.test.js and observe missing feature failures.
- [ ] Implement synchronous non-yielding guarded operations, hash preconditions, restrictive temporary writes.
- [ ] Rerun tests and commit.

## Task 2: Entitlements and job supervisor
Files: src/license.js, src/jobs.js; tests/license.test.js, tests/jobs.test.js.
Produces: verifyEntitlement(token, trustedKeys, binding, now); JobRunner.run/get/cancel.
- [ ] Write failing tests for signatures, binding, grace and duplicate job requests.
- [ ] Implement verification and atomic job records, output caps and cancellation.
- [ ] Run full suite; commit only after green.

## Task 3: Agent and gateway
Files: src/tools.js, src/agent.js, src/gateway.js, src/cli.js; tests/integration.test.js.
Consumes: guarded files, job runner, verifier. Produces: startGateway(config), startAgent(config).
- [ ] Test real MCP initialization, list and tool calls against real loopback gateway and agent.
- [ ] Test missing auth, tenant mismatch, request bounds, cancellation and project permissions.
- [ ] Implement SDK transport and bounded outbound polling with authenticated response binding.
- [ ] Run full tests and syntax checks; commit.

## Task 4: Distribution and commercial handoff
Files: plugin/, scripts/, config/, docs/, Dockerfile, .github/workflows/ci.yml, README.md.
- [ ] Add local credential-generation setup, endpoint-validated plugin packaging and runnable deployment instructions.
- [ ] Document exact license envelope, verification keys, renewal adapter boundary and production blockers.
- [ ] Validate plugin files and run CI-equivalent checks locally.
- [ ] Independent security review; fix important findings and rerun affected tests plus full suite.
- [ ] Upload preserving GitHub history; inspect commit and CI status.
