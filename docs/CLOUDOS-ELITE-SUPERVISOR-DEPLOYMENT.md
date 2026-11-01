# KMJ-elite CloudOS-only Supervisor — non-root socket plan

**Status: source-only; not installed, not production approval.** This applies
only to the already enrolled `kmj-elite-cloudos / kmj-cloudos` lane.
There is an unrelated live Main Platform Supervisor socket at
`/run/kmj-codebridge/supervisor.sock`, owned by `kmjcode`, mode `0600`.
**Never chmod, chgrp, reconfigure, share, or restart that socket/service.**

The offline renderer
`scripts/production/render-elite-cloudos-supervisor-units.py` accepts a full
40-digit immutable Git SHA and a fixed preapproved Node executable path. It
outputs JSON containing a service and socket unit. It does not install, stage,
write, start, or restart anything, and intentionally marks every release gate
false. The restricted service itself runs as unprivileged `kmjcloudosdev`,
not root; the dedicated socket is `0600` to that exact user. The handler
profile from CodeBridge #748 admits *only* fixed agent status, bounded device
status, and disk space. In particular it does not provide the QA worker,
arbitrary commands, root privileges, project traversal or VM lifecycle.

## Required privileged deployment review (not done by this renderer)

The authorized operator must separately attest the ELITE host, original
agent identity, immutable Git commit/source tree, root-owned runtime and
Node executable/ancestor permissions, service/socket unit trust, and
systemd sandbox compatibility. Stage the units under a separate name, back
up protected configuration and record rollback evidence. Reject any collision
with the existing private Main Platform socket or current CloudOS units.
Only after a privileged, reviewed activation may the CloudOS agent config be
updated to its new exact socket path, with existing gateway token and project
identity preserved. Verify a real restricted status RPC under the
`kmjcloudosdev` identity, negative denial of privileged RPCs, fresh signed
agent connection, unchanged Main Platform status, and rollback on failure.
A configured path is not proof of authenticated Supervisor service health.

ELITE still has no verified `/dev/kvm`, virsh or QEMU. A separate qualified
KVM compute host, two-tenant distinct-IP isolation, actual guest lifecycle,
independent offsite restore, rollback and **all 62** release gates remain
mandatory before CloudOS commercial production.
