// Which permission bits a POSIX config file may carry before a service reads
// credentials from it.
//
// Default for every mode: private to its owner (no group/other bits).
//
// The gateway additionally accepts the layout the Supervisor's fixed stage
// trust rule already requires (src/stage-gateway-config.js, trustedRootFile):
// owned by root, at most group-readable, nothing for others, not executable.
// With that layout the non-root gateway user can read its config through its
// group but cannot rewrite it. Before this, the two rules contradicted each
// other: a config the Supervisor trusted (root:group 0640) was refused by the
// gateway at start, and a config the gateway accepted (service-owned 0600)
// was reported by the Supervisor as CONFIG_TRUST_INVALID.
export function configModeAcceptable(serviceMode, stat) {
  if (!Number.isInteger(stat?.mode)) return false;
  if ((stat.mode & 0o077) === 0) return true;
  return (
    serviceMode === "gateway" && stat.uid === 0 && (stat.mode & 0o137) === 0
  );
}
