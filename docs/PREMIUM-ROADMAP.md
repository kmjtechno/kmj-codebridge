# KMJ CodeBridge Premium Delivery Roadmap

This document converts the commercial plan matrix into implementation gates. A feature must not be marketed as generally available until its code, entitlement enforcement, documentation and production rollout are verified.

## Product rule

The open-source Apache-2.0 core remains useful. Paid value should come from hosted convenience, scale, collaboration, compliance, support and managed operations rather than disabling already-published open-source rights.

## Capability groups

### Pro

Target capabilities:

- hosted account linking;
- up to the published Pro device/project/concurrency limits;
- signed commercial entitlement;
- renewable entitlement leases;
- extended job history;
- managed upgrade path.

Required gates:

- Main Platform plan/SKU exists;
- checkout and entitlement issuance work end-to-end;
- gateway enforces account plan limits;
- signed entitlement refresh/revocation works;
- customer dashboard shows only the customer’s registered/entitled service;
- upgrade, cancellation and expiry paths are tested;
- no paid state is trusted solely from client UI or a user-controlled agent.

### Team

Target capabilities:

- shared organization policy;
- role-based administration;
- larger limits;
- shared audit history;
- audit export;
- priority support workflow.

Required gates:

- organization membership and roles are authoritative server-side;
- policy changes are auditable;
- tenant isolation tests cover cross-user and cross-organization access;
- team limits are enforced centrally;
- audit export is scoped and redacts secrets;
- support entitlement can be verified without exposing billing details to unrelated users.

### Business

Target capabilities:

- custom limits;
- enterprise identity / SSO;
- procurement and invoicing support;
- optional SLA terms;
- advanced audit controls;
- enterprise support and deployment guidance.

Required gates:

- enterprise agreement/order controls the commercial terms;
- SSO is integrated against an approved identity standard/provider;
- support escalation and incident processes are documented;
- SLA metrics are measurable and operationally monitored before any guarantee is sold.

## Entitlement contract

Suggested plan identifiers:

- `community`
- `pro`
- `team`
- `business`

Suggested feature claims:

- `read`
- `write`
- `execute`
- `hosted_linking`
- `extended_history`
- `team_policy`
- `audit_export`
- `priority_support`
- `enterprise_identity`

Plan names are presentation. Authorization must depend on validated entitlement claims and server-side account policy.

## Trial model

Launch target:

- eligible new account;
- 30 days of Pro capability;
- no card required where operationally feasible;
- no automatic paid conversion unless the customer explicitly selects a paid subscription;
- anti-abuse controls for repeated trial creation;
- one authoritative trial start/end record in Main Platform;
- expiry returns the account to Community without deleting customer-owned project data.

## Upgrade and downgrade behavior

An upgrade should take effect after successful payment/authorization and entitlement issuance. A downgrade should preserve customer-owned data while removing access to paid-only service capabilities after the effective paid period ends.

Never make destructive deletion the default downgrade mechanism.

## Release discipline

For every paid feature, require:

1. implementation;
2. unit/integration tests;
3. tenant-isolation test where applicable;
4. entitlement enforcement test;
5. documentation;
6. billing lifecycle test;
7. observability;
8. rollback plan;
9. exact-head green CI;
10. production verification.

## Marketing claim rule

Use concrete, verifiable language. Do not claim “fastest”, “most secure”, “world’s cheapest”, certification, uptime, customer numbers or benchmark superiority without dated evidence that supports the exact claim.
