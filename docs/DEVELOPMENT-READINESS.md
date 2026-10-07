# Development readiness

Connection status is not proof that a project can build. `connection_doctor` retains its existing connection fields and now reports effective permissions and declared gate prerequisites. `inspect_project` stays unchanged.

## Declare prerequisites

An administrator can add up to 32 `requiredFiles` entries to each gate in the agent configuration. Paths are relative to the authorized project root and must be readable regular files. For example, a Laravel/Vite project can declare:

```json
{
  "full": {
    "command": "/bin/bash",
    "args": ["scripts/codebridge-quality-gate.sh", "full"],
    "timeoutMs": 300000,
    "requiredFiles": [
      "apps/platform/node_modules/vite-plus/package.json",
      "apps/platform/vendor/autoload.php"
    ]
  }
}
```

Use a regular package marker rather than a directory or executable symlink. Existing project path protections apply, including secret-file, traversal, hardlink and symlink restrictions. No file contents, command arguments, credentials or absolute project paths are returned by the new diagnostics. The doctor does not install dependencies, run commands or change permissions.

## Interpret results

Each `gateReadiness` entry has scope `declared_files_only` and one of:

- `not_configured`: no prerequisite files declared; readiness has not been established.
- `satisfied`: all declared files passed the path and readability checks. This does not verify executable availability, dependency versions, databases, model access or test success.
- `blocked`: a file is missing, denied or unreadable. Allowed missing paths are identified; restricted paths are not disclosed.

`effectivePermissions` intersects account permission, licensed features and project write policy. A project configured read-only does not advertise write or execute capability. OS execution can still fail even when an operation is authorized.

A new gate job with blocked prerequisites fails with `GATE_PREREQUISITES_NOT_MET` before a subprocess or journal entry is created. Run the doctor to see what needs attention, provision dependencies through an authorized setup workflow, then retry. Existing jobs remain retrievable through an idempotent replay even if a prerequisite subsequently disappears. Gates without requiredFiles retain their previous execution behavior; upgrade the device agent before configuring this field because older agents do not enforce it.

## Startup verification

`npm run check` now loads gateway and agent startup module graphs using separate Node processes with a ten-second timeout and a limited environment. Unlike syntax-only checks, this catches missing ESM exports and CommonJS assignments in ESM before release. It does not start a gateway or agent, read deployment credentials, or prove network/service health.

## Delivery scope

This change improves the existing project-scoped development tools. It does not add an unrestricted terminal, automatic dependency installer, private-model provider or autonomous AI worker. Active deployments must be upgraded and their administrator-owned configuration updated before these capabilities are available there.
