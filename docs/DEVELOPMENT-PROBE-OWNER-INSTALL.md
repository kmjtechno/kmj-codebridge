# KMJ-elite non-root development probe — owner-only installation gate

This runbook concerns **only** the inert probe introduced in PR #648. The
root-owned unit and Python helper are source inputs, not a running service.
This installer does **not** enable autonomous coding, install or update the
CodeBridge agent, start the probe, authorize a root shell, or deploy Main
Platform. A green PR does not establish host readiness.

## Provenance and approval

The reviewed PR #648 merge commit is
f9f58e2eccf4dcfee5751c1c469487383114657d.
The exact unit SHA-256 is
b851bb24cc5a846e3fc95a96893483f0dfd6540c91bc37d93a4f91aefd0ef53b.
The exact helper SHA-256 is
1191b0ebff956e64da17e52b6dd65b43afe3c80bdad21900a4c719d941da5be7.

The _installer itself_ is added in a later source commit; do not treat the
PR #648 merge SHA as its installer SHA. Before any root action, the owner must
review the installer from an exact, green, immutable commit and independently
verify the downloaded archive and installer bytes. The two source-file hashes
above are embedded in the installer and checked again before any mutation;
they are **not** a digital signature or proof that the installer is trusted.

## Two deliberately separate steps

1. An owner may perform the read-only source inspection from a verified
   checkout using:
   bash scripts/production/install-development-probe.sh --inspect
   This only checks the unit/helper SHA-256 and returns
   KMJ_DEV_INSTALL=INSPECT_ONLY. It does not need root and cannot report
   host installation.
2. Only after independent review, owner approval, and a verified archive
   extracted as root under
   /root/kmj-approved/<exact-reviewed-commit>/
   may the owner run
   bash scripts/production/install-development-probe.sh --install
   on **KMJ-elite**. The installer refuses other hosts, non-root users,
   symlink sources, non-root-owned or writable source directories, mismatched
   source hashes, existing installed targets, or an existing systemd unit.
   It creates a dedicated non-login kmjdevci account only if both account and
   group are absent; otherwise it verifies their existing identity. It installs
   the fixed helper and unit with root ownership, prepares a private state
   directory, and reloads systemd. It **never starts or enables** the unit.

The owner should retain the independently verified archive and a sanitized
receipt, not private agent configuration or raw root logs. If an installation
partially fails, do **not** rerun blindly or delete an existing unit; inspect
the root-owned targets and systemd state first. There is intentionally no
unattended rollback that could overwrite another operator's work.

## Atomic publication and partial-install recovery

The final helper and unit use Linux same-directory `ln -T --` without
`--force`: exclusive destination creation is atomic and cannot overwrite
an existing regular file or symlink even when another process races after
the preflight absence check. Staged temporary files and final targets have
the same filesystem. The first successful link may remain if the second
link fails; the installer reports
`KMJ_DEV_INSTALL=BLOCKED_PARTIAL_INSTALL_REVIEW_REQUIRED`.
**Do not auto-delete, re-run, or replace anything.** Review the exact
two installed paths, SHA-256 pins, ownership, link/type, actual unit state,
and any competing owner activity. Restore a clean state only through a
separately approved root-owned recovery procedure after independent review.
Do not interpret a partial publication as a completed installation.

**Current-host caveat:** an earlier non-root probe installer (merged
PR #650) already installed the fixed development CI service on KMJ-elite.
This draft #649 installer must NOT be run over that existing installation.
The hardened draft is retained for source review/negative-test coverage;
fixing its race does not repair the distinct non-root probe execution failure
tracked in #652, nor does it activate autonomous coding.

## Gates still required after installation

- Verify the installed root-owned unit and helper against the exact source
  and effective systemd hardening through a **signed, canary-tested agent**
  exposing the new Supervisor operation. The currently installed KMJ-elite
  agent 0.3.2 does not prove this catalog is available.
- Independently qualify the signed agent upgrade, preserved enrollment,
  rollback to the previous runtime, and authenticated reconnect. This
  installer does not modify the agent, gateway, updater, credentials, or
  production release.
- A separate explicit owner-approved probe start may then run only the fixed
  read-only Git HEAD probe. A successful probe is not a coding worker.
- For actual unattended coding, require a running consented zero-cost local
  model, a lease-bound isolated worktree, strict per-project grants and
  edit-path allowlists, independently approved safe verification gate,
  durable no-replay checkpoint, review-only patch receipt, restart recovery
  and real end-to-end evidence. Do not enable or advertise 24×7 coding until
  all these are demonstrated.

No SSH/firewall change, payment, Main Platform cutover, protected approval
change, or unreviewed root command is part of this procedure.
