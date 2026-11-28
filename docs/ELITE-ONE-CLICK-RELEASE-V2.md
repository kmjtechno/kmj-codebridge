# Elite One-Click Release V2

This is a versioned candidate, not a live root installation. V1 binaries,
signer policy, signing keys and existing deployment timers stay unchanged.

After independent review, CI and a separately verified create-only installer,
the owner can use one command:

```sh
kmj-one-click-release --project codebridge --action release --confirm OWNER_APPROVES_PINNED_FAST_RELEASE
```

No manual SHA is required. The dispatcher selects the exact current main SHA,
checks required workflow admission and passes that same SHA to the dedicated
nonroot signer. The signer rechecks fetched and remote main, protected review,
exact checks, signed history, sequence ceiling, key identity and the policy
again before key use. If the source changes, signing stops; no silent retry
against a different source. The signed PR is queued for GitHub's independent
protected review and auto-merge. A signing receipt is not a live receipt.

The owner can use `--action preflight` instead of release, without a confirmation
or manual SHA. This performs key-free signer admission (it may fetch and take
a temporary private lock), reports the intended sequence and exact SHA, and
never signs or publishes. Known blocker codes such as
`SEQUENCE_POLICY_EXHAUSTED` are preserved; arbitrary child output is not exposed.

The installer creates versioned files and a separate command. It refuses
conflicting files and leaves V1 usable. The reviewed SHA and installer digest
must be independently verified by the owner before use. Existing policy expiry
and sequence ceilings are never extended by either V2 action. A future bounded
owner enrollment and authenticated dashboard broker are separate work. The
existing independent review and signed deployment/rollback timers remain
authoritative. Live activation and health still require verification.
