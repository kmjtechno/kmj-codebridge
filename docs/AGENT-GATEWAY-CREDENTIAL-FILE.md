# CodeBridge gateway bearer credential file (new service enrollment only)

**Status:** source-level credential isolation building block. This is not a
Windows service installer, approved live enrollment migration, signed release,
gateway authentication canary, managed takeover or rollback.

## Why

The original `agentSchema.token` field kept the enrolled gateway bearer
inside `agent.json`. P720's original `agent.json` belongs to the currently
connected user agent; a SHA-pinned LocalService task-context canary proved that
it is not readable by that unrelated account. **Do not alter its ACL, copy its
bearer or start a second enrolled agent under the same device identity.**

The new `gatewayTokenFile` setting is an alternative for a separately
provisioned identity, not a way around the live agent's security boundary.

## Configuration (example, placeholders only)

```json
{
  "gateway": "https://kmjtechno.com/",
  "id": "separately-approved-device-id",
  "tenant": "approved-tenant-id",
  "gatewayTokenFile": "C:\\ProgramData\\KMJ-CodeBridge-Service\\private\\gateway-bearer.txt",
  "stateDir": "C:\\ProgramData\\KMJ-CodeBridge-Service\\state",
  "projects": [
    {
      "id": "approved-project-id",
      "root": "D:\\KMJ-Approved-Project",
      "writable": false
    }
  ],
  "license": { "mode": "free" }
}
```

Exactly **one** of `token` (backward compatible) and
`gatewayTokenFile` is allowed. Zero sources or both sources fail schema
validation. The external file must be absolute, regular, non-symlink,
between 32 and 4098 bytes, outside all authorized project roots and the
agent's state directory; no symlink aliases are accepted. A single final
newline/CRLF is allowed. The credential itself must be 32–4096 printable
non-whitespace ASCII characters. Failure produces only a fixed error marker
without the file path or credential contents, before workers or the agent
state lock start.

On POSIX the file must belong to the agent process UID with no group/other
mode bits. On Windows the CodeBridge Windows token ACL guard must succeed
before the bearer is opened. This is **a defense-in-depth ACL guard, not a
complete Windows service identity or enrollment attestation**. Its exact
SID, service configuration, credential-at-rest protection and directory
ACLs must be independently verified on the physical machine.

The read operation has no write/rename/chmod/copy branch. Never store the
bearer under a repository, test fixture, logs, GitHub, a shared user
directory, the existing owner-private agent folder or ChatGPT.

## Deployment acceptance criteria

1. Keep both original P720 agents and dirty checkouts untouched and the
   S4U managed task disabled.
2. Choose and install an isolated service identity and Windows service
   host with explicit, narrow private directory ACLs (separate change).
3. Obtain the operator-approved **new/rotated** enrolled gateway bearer
   locally into a service-specific credential store. Do not reuse the
   current user-owned token or request it in chat.
4. Confirm single-device ownership fencing and zero in-flight work before
   moving from the old process to the new identity.
5. Prove fresh, authenticated, server-observed heartbeat from the new
   identity followed by a bounded negative/positive rollback drill.
6. Test no-user-logged-on cold boot, connection loss, service restart,
   identity permissions, signed native updater, renewal and crash recovery.

The file-based credential source is one prerequisite for these gates,
**not production-readiness by itself**.

Related: [P720 private enrollment boundary](P720-PRIVATE-ENROLLMENT-BOUNDARY.md)
and CodeBridge issue #393.
