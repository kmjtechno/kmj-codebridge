# CloudOS N2 stopped boot disk: real GCE evidence and guarded recovery plan

**Observed:** 2026-11-04 11:02:59Z. The owner executed the SHA-256-pinned PR #829 read-only Google Cloud Shell inventory on the exact project/zone. All statements here distinguish observed GCE state from unverified recovery.

## GCE state, witnessed by owner

| Fact                                 | Receipt                                                        |
| ------------------------------------ | -------------------------------------------------------------- |
| Identity                             | `kmj-techno/us-central1-a/kmj-cloudos-kvm-test` EXACT_VERIFIED |
| N2 state                             | `TERMINATED`, deletion protection true                         |
| Source boot disk                     | `kmj-cloudos-kvm-test`, 30 GB, `pd-standard`                   |
| Source disk attachment mode          | `READ_WRITE` on original N2                                    |
| Running same-zone/VPC relay          | `instance-20260912-094732`                                     |
| Concurrent read-only attach to relay | CONFLICT: source is attached READ_WRITE                        |
| Source disk mode rollback            | NOT_VERIFIED                                                   |
| Encrypted disk transfer              | NOT_ATTEMPTED                                                  |
| Disposable independent boot recovery | NOT_VERIFIED                                                   |
| GCE mutations from audit             | NONE                                                           |

The source disk's **existing RW attachment is incompatible with a simultaneous RO attachment**. A future cold extraction could involve changing the original boot-disk attachment after verifying stopped state and explicitly planning reattachment. That is not authorized by this read-only inventory.

## Before any disk write or attachment change

1. Record exact source disk ID, deviceName, interface, current attachment mode, boot flag, autoDelete=false, deletion protection, and GCE project/zone. Independently verify that original N2 stays terminated and there is no concurrent writer.
2. Describe the exact existing relay by API, not only listing. Verify `RUNNING`, same zone, same VPC, current disk attachments, source disk absent on relay and least-privilege access. Never allow relay to auto-mount an unknown disk writable. Do not expose private AGE identity on Google relay or ELITE.
3. Verify the owner's AGE passphrase-encrypted USB identity on **a different trusted computer** (not P720), not merely by rereading it on P520. Then independently review the ELITE **public recipient only** enrollment (#826).
4. Confirm zero **incremental** paid resource spend (including internet egress to ELITE). Google documents default **Premium Tier** and network egress costs; Standard Tier can have a monthly free egress allowance, but only when actually used and sufficient allowance remains. No zero-cost eligibility is inferred from the 30 GB disk or the existence of a relay. Never change network tier blindly.
5. Independent reviewer must approve an explicit reversible sequence, including how to reattach the **same** boot disk to the original stopped N2 with its original `boot=true`, original deviceName/interface, `READ_WRITE` and `autoDelete=false`, even when transfer fails or the relay stops. A before/after full GCE metadata witness is required. There must be an available recovery operator if that repair itself fails.
6. Verify root-only destination backup capacity and bounded, resumable **encrypted** streaming with SHA256 independently obtained from source; 22 GB free on the existing relay is insufficient to stage a 30 GB raw image. The SFTP receiver and root vault are separate, and the caller-supplied ciphertext hash alone is not trusted provenance.
7. A full archive must be checked by decryption and a disposable **booted** restoration of matching source bytes, while the protected original boot disk remains intact and recoverable. Real guest/network negative tests must prove isolation of both tenant instances.
8. Do not grant a commercial launch PASS until independently verified release evidence satisfies all 31 Phase-1 plus 31 Phase-2 mandatory gates, with no open P0/P1 blockers.

## Explicitly prohibited shortcuts

- Do not attach the existing READ_WRITE boot disk read-only to the relay while the original attachment persists.
- Do not silently detach, delete, resize, format, snapshot, mount writable, start the N2, buy cloud storage or switch networking tiers.
- Do not copy an unencrypted source image to the relay's already space-limited root filesystem.
- Do not transfer the owner AGE private key or recovery passphrase into ELITE, GCE, GitHub, CodeBridge or logs.
- Do not treat passing source CI, small SFTP canaries, a matching untrusted manifest, or same-device USB recovery as actual independent restore evidence.

**Release verdict: BLOCKED.** This document and the initial API inventory are not deployment or disk-transition authorizations.

Sources: Google Compute Engine [boot disk detachment/reattachment](https://docs.cloud.google.com/compute/docs/disks/detach-reattach-boot-disk), [disk sharing mode rules](https://docs.cloud.google.com/compute/docs/disks/sharing-disks-between-vms), [GCP network pricing](https://cloud.google.com/vpc/network-pricing).
