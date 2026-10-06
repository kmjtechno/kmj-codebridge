# KMJ CodeBridge Connection Doctor

**Goal:** Connect a new KMJ Main Platform testing agent without changing the existing `device1 / project1` installation or asking the user to reauthorize ChatGPT repeatedly.

## One step inside ChatGPT

Ask:

> KMJ CodeBridge, run `connection_overview` and show which device needs attention.

The read-only MCP tool needs **no parameters**. If the new device does not appear in the account grants, use its exact `configured_device_id` reported by the VM doctor:

`connection_overview({"expectedDevice":"main-platform-example"})`

It reports only devices/projects already granted to the authenticated account. An ungranted expected device gets `ACCOUNT_GRANT_MISSING`; that result **does not disclose whether the device exists** on another tenant.

| Status | Meaning | Next action |
| --- | --- | --- |
| `READY` | Gateway registered and heartbeat online | Use the authorized project |
| `ACCOUNT_GRANT_MISSING` | No grant in the signed-in user's Main Platform account | Check KMJ organization, CodeBridge license, pairing and device grants |
| `GATEWAY_REGISTRATION_MISSING` | User grant exists, but the gateway has not accepted an agent identity | Run the VM doctor, check credential introspection and gateway health |
| `PROJECT_SCOPE_MISMATCH` | Gateway accepts this device but does not grant the requested project | Check the enrolled project ID, credential pairing and intended project grant |
| `AGENT_NEVER_ONLINE` | Gateway has a registered identity without a successful health call | Check agent service, runtime permissions and network |
| `AGENT_OFFLINE` | Identity exists but the heartbeat is stale | Check agent service logs and connectivity |
| `NO_GRANTED_DEVICES` | No explicit device/project grant was returned | Check OAuth subject and Main Platform organization grants; **do not reconnect repeatedly** |

## One safe diagnostic on the testing VM

Using the code on the VM:

```bash
sudo bash scripts/diagnose-main-platform-agent.sh
```

The script checks the **new Main Platform agent only**, `kmj-codebridge-kmj-main-platform.service`, and prefers `/etc/kmj-codebridge-main-platform/agent.json`. It falls back to the legacy `/etc/kmj-codebridge/agents/kmj-main-platform.json` only when the new config is absent.

It reports the configured device/project/tenant identity, service status and service-user permissions, last recorded connection, Main Platform credential introspection, and gateway `/agent/health` HTTP result. Only fixed error-code counts, not raw journal contents, are printed. The only remote state effect is a legitimate, authenticated agent-health probe. **It does not restart services, rewrite configs, enroll/revoke credentials, alter grants, or touch `project1`.**

A successful gateway health result proves the agent token was accepted and registered in that gateway process. It does **not** by itself prove the signed-in ChatGPT user has a matching organization/device grant; use `connection_overview` to verify that separately.

## Interpret VM output

- `node_access=DENIED_TO_SERVICE_USER`: check the runtime's directory traversal/execute permissions (prior systemd `203/EXEC` is consistent with this).
- `credential_introspection_http=401`: credential inactive, expired, revoked or not issued by the current Main Platform; check the correct pairing without touching any existing credential.
- `credential_identity=MISMATCH`: the local device ID or tenant does not match what Main Platform authorized. Stop; do not edit the old `project1`.
- `remote_project_grant=MISSING`: the credential is active, but not for `kmj-main-platform`.
- `gateway_agent_health_http=401`: gateway rejected the token; verify its agent-introspection endpoint, tenant/project identity and any ID collision.
- `gateway_agent_health_http=200`: the gateway accepted the device; then check `connection_overview` for account/project scope.
- `gateway_agent_health_http=NETWORK_ERROR`: check gateway URL/network/TLS/reverse proxy rather than reconnecting OAuth.

## Production acceptance

Declare the new Main Platform agent online only after all three pass:

1. Device token introspection returns an active matching device/tenant/project.
2. The live gateway accepts the agent health request and receives ongoing heartbeats.
3. With the intended signed-in account, `connection_overview` shows `READY` for **the new** device and `kmj-main-platform`.

The existing `device1 / project1` must remain unchanged and functional. Source-level CI passing is **not** equivalent to these live acceptance checks.
