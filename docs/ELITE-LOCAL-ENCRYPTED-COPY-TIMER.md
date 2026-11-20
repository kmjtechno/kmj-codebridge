# KMJ-elite daily local encrypted copy (owner one-click)

`scripts/production/owner_elite_local_encrypted_copy_timer.py` installs a daily
timer that age-encrypts the newest daily backup into
`/var/backups/kmj-elite-offsite-encrypted/` using the already pinned recipient
file. It keeps the KMJ-elite health check's freshness check truthful without any
Google/SFTP dependency.

**This is not offsite disaster recovery.** The copy stays on the same VPS and
disk. The private key is not on the host, so the archive cannot be decrypted or
restore-tested there.

- Dry run by default; `--apply` installs three root-owned files and enables one
  timer (04:30 UTC daily, persistent).
- Never overwrites a different existing file; never touches the existing daily or
  offsite units, drop-ins, network, database, production or staging.
- The installed script only reads the daily backup and the recipient file, and
  writes ciphertext plus a sha256 sidecar.
