# UI-first project management

Status: architecture lock for the next CodeBridge project-management slice.

## Product decision

After the initial CodeBridge host agent is installed, adding, repairing, switching, or removing projects must be browser/UI driven. Customers must not need to edit systemd units, JSON config, SSH keys, service permissions, or run repair scripts for normal project management.

The current "one systemd service per project" experiment is not the target architecture. It creates avoidable runtime, ownership, and permission drift. The target is one managed CodeBridge host agent per device with multiple authorized project grants.

## Required UX

From **KMJ Main Platform -> KMJ CodeBridge -> Projects**:

1. Click **Add project**.
2. Choose an already enrolled device.
3. Choose an authorized GitHub repository.
4. Confirm project name, access level, and quality-gate preset.
5. Click **Install project**.
6. The UI shows `Preparing -> Authorizing -> Syncing -> Online` and then the project becomes available to connected AI clients.

No terminal command, deploy-key copy/paste, manual systemd editing, or credential handling is part of this normal flow.

The same page exposes **Repair**, **Reconnect**, **Pause**, and **Remove** actions. These actions are idempotent and never expose secrets.

## Security invariants

- One authoritative device credential; project access is represented by server-side project grants.
- Project grants are tenant-scoped and device-scoped.
- Repository selection is limited to repositories authorized to the KMJ account.
- Local project roots are generated under an administrator-controlled root such as `/srv/kmj-codebridge-projects/<project-id>`; callers cannot submit arbitrary filesystem paths.
- No arbitrary shell command is accepted from the browser or gateway.
- Quality gates come from administrator-controlled presets, not caller-provided shell strings.
- Privileged host changes are handled by the bounded root supervisor through a narrow allowlisted protocol.
- Credentials, deploy keys, and license tokens are never rendered into the browser.
- Existing `project1` remains untouched when another project is added.
- All add/repair/remove operations are audit logged.

## Backend model

The Main Platform becomes the authority for device-to-project grants and setup jobs.

Required records:

- `codebridge_device_project_grants`
  - tenant
  - device credential
  - project id
  - repository
  - permissions
  - gate preset
  - status
  - timestamps / revocation

- `codebridge_project_setup_jobs`
  - tenant
  - device id
  - project id
  - desired operation
  - current state
  - bounded error code
  - created / started / finished timestamps

Credential introspection returns all active project grants for the device.

## Agent/supervisor contract

The existing host agent periodically receives signed/authorized project intents for its own device. It never accepts a raw path or shell command.

The root supervisor implements bounded operations:

- ensure project checkout
- ensure ownership
- ensure gate preset
- ensure project grant is present in the host agent configuration
- reload/restart the single host agent only when required
- report status

The supervisor must reject unknown repositories, paths, services, gate definitions, or tenants.

## Acceptance

A setup is complete only when:

- the project is visible in the Main Platform UI,
- the device reports the project grant,
- the gateway lists the project for the authenticated account,
- `inspect_project` returns the expected repository identity,
- no manual terminal repair was required after the initial host enrollment.
