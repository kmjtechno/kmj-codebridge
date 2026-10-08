# Native CI prerequisites

The existing Main Platform VPS updater provisions a fixed CI-only Rust 1.90.0
and PostgreSQL 17.10 installation. No paid service, production PostgreSQL
cluster, database, role, entitlement or billing configuration is changed.

Vendor archives use immutable official HTTPS URLs with SHA-256 pins committed
in `scripts/install-native-ci-prerequisites.sh`. All four Rust component pins
have been verified by downloading the official archives locally; those archives
contain no symlink or hardlink entries. PostgreSQL's source SHA-256 comes from
its official release checksum. Compiled/installed outputs reject privileged modes and unexpected file types.
Only eight exact relative PostgreSQL SONAME aliases are allowed, derived from
the checksum-verified17.10 library Makefiles. Each must name its exact regular
internal target; all other symlinks, including Rust/cache/directory links, fail.

The installer requires existing Python 3.12, compiler, make, bison, flex and
`pg_virtualenv` tools. Missing prerequisites fail explicitly; it does not install
APT server packages, execute their maintainer scripts or create a host cluster.
Rust component installation, PostgreSQL compilation and public Cargo fetch run
only as the separate nologin `kmjci-build` identity, with no additional groups,
empty environment, a 2 GiB memory limit, two CPU limit and twenty-minute deadline.
The builder is sealed into a separate root-owned, read-only and traversable
staging directory. Only its fresh work directory is writable in its sandbox.

Only the reviewed Cargo manifest and lock shared by production source HEAD and
both fixed candidates are exported. Cargo never runs as root. Repository Cargo
configuration, source/build scripts, credentials and private keys are excluded.
Only checksum-matched crates and public registry index files enter the root-owned
sealed cache; its exact lock digest and each file digest are validated again
before publication and before either PR preparer copies it into a job. All CI
Rust test execution remains offline and locked. Incompatible locks fail closed.

Runtime publication uses fresh root-owned staging directories and atomic rename.
Retries verify existing runtime/cache metadata instead of overwriting installed
binaries or existing PostgreSQL paths. The only PostgreSQL compatibility links
are `/usr/lib/postgresql/17` and `/usr/share/postgresql/17`; they must be absent or
match this exact root-owned CI installation. `pg_virtualenv` continues to create
only the existing disposable test clusters inside the isolated worker.

Local verification covers vendor hashes/archive entries, lock/checksum/cache
corruption, credential exclusion, ownership/modes, symlinks, missing runtime
outputs and immutable builder staging assertions. A full native installation,
PostgreSQL source build, Cargo fetch and exact-head job execution still require
the approved existing VPS: the local test namespace cannot switch UIDs or run
systemd. Source checks do not claim those production-side operations succeeded.

The existing `update_status` readback includes only a root-owned, private,
size-bounded prerequisite record: `INSTALLING`, `READY` or `FAILED`, with a
missing tool enum restricted to `CC`, `MAKE`, `BISON`, `FLEX`, `PG_VIRTUALENV`
or null. Missing build tools are checked before vendor fetch/build. `READY`
means dependency publication passed validation; it does not mean native CI,
production deployment or Owner activation passed.
