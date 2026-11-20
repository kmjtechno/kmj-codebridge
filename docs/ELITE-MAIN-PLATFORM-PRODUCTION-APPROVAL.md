# Main Platform production approval (KMJ-elite, owner one-click)

`scripts/production/owner_main_platform_production_approval.py` writes the
root-protected production approval that the Supervisor and the fixed activation
controller require. The owner runs it as root on KMJ-elite; the owner's explicit
flags are the attestation. Claude never runs it.

- Default is a **dry run**. Writing needs `--apply --attest-backup --attest-rollback`.
- Writes exactly the four keys the Supervisor accepts: `approvedSha`,
  `expectedCurrentRelease`, `backupVerified`, `rollbackVerified`.
- Takes the exact SHA and the live predecessor release as explicit owner inputs
  (`--sha=<40 hex> --live=platform-<12 hex>`; nothing is inferred) and binds them to
  the real host: the live pointer must equal `--live`, the candidate must be
  `platform-<sha12>`, and the backup witness must name exactly that SHA, that live
  release and the archive digest.

## Verified on the host

Live release equals the pinned predecessor; the candidate release exists, is not
group/world writable, uses the approved shared storage link, has a private
regular `.env` and the build artifacts; the local pre-deploy backup witness binds
the exact SHA, the live release and the archive digest.

## Not verified here

The disposable restore result (printed by the reviewed recovery script), customer
QA, and a physical rollback drill. The activation controller itself performs and
verifies an automatic rollback if activation or health fails; an isolated CI
rehearsal is the only earlier rollback evidence. No staging test of the exact SHA
is performed by this tool.

## Never does

Activate, start a unit, move `current`/`previous`, touch staging, the database,
DNS, Google/offsite or the network, or run a command. An existing approval is
backed up to `/root` first. Activation is a separate Supervisor step.
