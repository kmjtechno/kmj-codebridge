# Main Platform staging approval (KMJ-elite, owner one-click)

`scripts/production/owner_main_platform_staging_approval.py` writes the
**root-protected staging approval** that the fixed staging deploy runner
requires. It is an owner tool: the owner runs it as root on KMJ-elite and the
owner's explicit flags are the attestation. Claude never runs it.

## What it does

- Default is a **dry run**: it checks the real host and prints the approval it
  would write.
- Writing needs `--apply` and all four of `--attest-backup`,
  `--attest-rollback`, `--attest-storage`, `--attest-zero-cost`. Any partial or
  unknown combination is blocked.
- It pins the exact approved SHA, the live production release, and the SHA-256
  of the installed runner and unit. Any drift blocks.

## What it verifies on the host

| Check                                                        | Verified here |
| ------------------------------------------------------------ | ------------- |
| Host `KMJ-elite`, root, live release equals the pinned one   | yes           |
| Staging candidate sealed, root-owned, seal digest present    | yes           |
| Installed runner and unit equal the pinned bytes, no drop-in | yes           |
| Local pre-deploy backup witness bound to the exact SHA       | yes           |
| Disposable PostgreSQL restore result                         | no (see note) |
| Rollback                                                     | no            |
| Storage continuity, zero additional cost                     | no            |

The restore result is printed by the reviewed local recovery script when it
runs; this tool only checks that its witness and archive digest match.
`--attest-rollback` currently rests on an isolated CI rehearsal, **not** a
physical Elite switch. `--attest-storage` and `--attest-zero-cost` are owner
judgements.

## What it never does

No deploy, no unit start, no staging or production pointer change, no
production approval, no DNS, no Google/offsite, no network, no command
execution. An existing approval is backed up to `/root` before it is replaced.

## Use

```bash
python3 -I owner_main_platform_staging_approval.py            # dry run
python3 -I owner_main_platform_staging_approval.py --apply \
  --attest-backup --attest-rollback --attest-storage --attest-zero-cost
```

Afterwards run the staging deploy unit through the Supervisor, then check
`supervisor_main_platform_staging_status`. Production approval is a separate
step.
