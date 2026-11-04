# CloudOS N2 cold-disk encrypted backup and restore gates (2026-11-04)

**Status: BLOCKED.** This is a plan / source contract, not a backup receipt or authorization to touch a protected VM. The GCE N2 test VM `kmj-cloudos-kvm-test` is in project `kmj-techno`, zone `us-central1-a`, with its existing 30 GiB-class standard PD boot disk preserved and deletion protection. Source, network and run-time identity must be reverified at operation time.

## Locked safety boundaries

- No additional paid cloud resources, no snapshot/image/disk clone, no GCE VM start without separately verified cost and an explicit bounded execution approval. Do not delete or format the protected disk.
- The owner AGE **private key stays outside ELITE, Google VPS, GitHub, ChatGPT and CodeBridge logs**. Only the matching public X25519 recipient and SHA256 may be installed on ELITE. P520's passphrase-protected USB backup has a same-P520 decrypt/SHA256 PASS; **a different trusted machine recovery remains unverified**.
- The existing `kmjcloudosbackup` account is restricted to the authenticated, chrooted SFTP `/incoming` spool. It has no write access to the private root-only backup vault `/srv/kmj-cloudos-n2-offsite`. A root-mediated, SHA-checked promotion from a completed spool into the vault will require separate code, QA and approval; never give the SFTP user access to the vault.
- The Google relay has been observed with about 23 GiB free. Do not stage a 30 GiB-class raw disk there. If permitted, only a bounded **streaming** route may be considered, with no local raw-image staging.
- Neither source CI nor successful SFTP canaries is evidence for a full encrypted backup or a bootable restore.

## Before any data capture: GCE attachment mode and spending gate

Recheck the **actual** GCE N2 state `TERMINATED`, exact project/zone, boot disk identity, auto-delete disabled, deletion protection and existing relay instance's exact zone before any new action. Check every current disk attachment mode and disk sharing compatibility.

Google Cloud documents that standard Persistent Disks may be shared read-only between same-zone instances and that all simultaneous attachments must use the same mode. A disk attached read/write to the stopped N2 must **not** simply be attached read-only to the relay without a reviewed mode transition and rollback plan. See [Share disks between VMs](https://docs.cloud.google.com/compute/docs/disks/sharing-disks-between-vms) and [Attach a non-boot disk](https://docs.cloud.google.com/compute/docs/disks/attach-disks).

A possible future use of an **existing** same-zone running relay to read the **stopped** source boot disk may avoid a new disk or snapshot, but still requires independent evidence of compatibility, cost, protected attachment/restore state, no boot-disk edits, and operator approval. Cloud egress charges cannot be assumed zero. Do not treat this as an approved procedure.

## Cold archive layout and untrusted receipt contract

The future source capture tool must determine the actual raw block-device byte length, stream the entire cold, unmounted device to the fixed owner public AGE recipient, SHA256-hash the raw source bytes **during** the stream and separately hash ciphertext after receipt. It must capture exact disk identity, immutable instance/disk metadata and GCE termination witness independently. Neither a manifest alone nor file size can prove that all source bytes were captured.

After an authenticated, fully completed, hash-checked upload and a root-only admission/promotion (separate future gated work), the private vault should contain **exactly one** matching pair:

- `n2-cold-<lowercase-32-hex>.age`: AGE encrypted ciphertext, regular root-owned `0600`, single link.
- `n2-cold-<same-id>.json`: strict ASCII-compatible UTF-8 manifest, regular root-owned `0600`, single link, max 4096 bytes.

The only accepted fields are `schema`, `capture_id`, `project`, `zone`, `instance`, `source_disk_bytes`, `captured_at_utc`, `capture_method`, `source_state_reported`, `age_recipient_sha256`, `source_disk_sha256`, `ciphertext_bytes`, `ciphertext_sha256`. Use `kmj.cloudos.n2.cold-cipher-manifest.v1`; exact source project `kmj-techno`, zone `us-central1-a`, instance `kmj-cloudos-kvm-test`, `capture_method=cold-block-read` and `source_state_reported=TERMINATED`. Record actual measured byte counts/digests, not an assumed 30 GiB value.

The verifier script in this PR is **read only** and checks strict no-follow root-owned vault/file descriptors, exact manifest and source identity, canonical timestamp, duplicate/unknown fields, trusted owner public-recipient SHA256, AGE header, size and full SHA256 streamed across the ciphertext. On a matching manifest it reports `PASS_LOCAL_UNTRUSTED_MANIFEST_SHA256` — **not** a completed source backup or an independently recoverable image. The manifest is self-reported and unauthenticated. A malicious manifest and corresponding ciphertext could produce a matching hash.

## Independent restoration gate

A full release requires a separate trusted device to decrypt the USB-stored, passphrase-encrypted AGE identity (without moving raw private material onto ELITE). From a *real source-captured* archive, decrypt through an owner-controlled protected mechanism to a disposable isolated restore target, verify restored raw byte count and SHA256 against independently witnessed source stream, then boot/test CloudOS and roll back **without modifying the original N2 boot disk**.

The restored VM must have no uncontrolled network reachability or tenant crossover. Check KVM guest boot, QGA, per-tenant libvirt network isolation, storage consistency, schema/application service health, observed rollback, boot disk restoration, and all 62 CloudOS release gates. Only direct operator-generated receipts from the actual restored VM count; offline fake-host tests and script-local assertions do not.

## Current verified evidence and missing gates

- P520 AGE local encrypt/decrypt and encrypted USB identity decrypt/SHA256 **PASS**. Owner second-device recovery **NOT VERIFIED**.
- ELITE protected root-only backup vault and capacity check **PASS_SIZE_ONLY**; owner public AGE recipient **NOT INSTALLED** at last actual root preflight.
- Restricted relay SFTP host key, auth, shell/forward negatives and small canary SHA256/cleanup **PASS**; no full source disk bytes transferred.
- CloudOS integration PR #144 source CI **PASS**, still **DRAFT** awaiting real N2 multi-tenant network proof.
- This repo's public-only recipient PR #826, independent USB recovery witness PR #827, and cold archive integrity PR #828 are **source-only** and do not activate N2 backup.

**Production release status: BLOCKED** until separate-device owner recovery, owner-only public recipient enrollment, verified cold source capture and encrypted end-to-end transfer, restored boot/rollback and real two-tenant security qualification.
