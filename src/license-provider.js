import fs from "node:fs";
import path from "node:path";
import { fail } from "./errors.js";
import { verifyEntitlement } from "./license.js";

const FREE_ENTITLEMENT = Object.freeze({
  features: Object.freeze(["read", "write", "execute"]),
  limits: Object.freeze({ concurrent_jobs: 1 }),
});

// Builds the per-call entitlement check used by every tool and worker.
// `fallbackToFree` (signed mode, opt-in, single project) turns an authentic
// lapsed or revoked lease into Free limits instead of a lock-out. Tampering,
// replay, clock rollback, missing or unreadable tokens never fall back.
export function createLicenseProvider(
  c,
  stateDir,
  { now = () => Math.floor(Date.now() / 1000), onTransition } = {},
) {
  const licenseState = path.join(stateDir, "license-state.json");
  let trusted = fs.existsSync(licenseState)
    ? JSON.parse(fs.readFileSync(licenseState, "utf8"))
    : { sequence: -1, lastTime: 0 };
  // Report only CHANGES of licence state (never per tool call), so the audit
  // trail records ACTIVE -> REVOKED/FREE_FALLBACK/denied without flooding.
  let lastState;
  const observe = (kind, code) => {
    if (kind === lastState) return;
    const previous = lastState;
    lastState = kind;
    if (previous === undefined && kind === "ACTIVE") return;
    try {
      onTransition?.({ from: previous ?? null, to: kind, code: code ?? null });
    } catch {
      // Auditing must never change an entitlement decision.
    }
  };
  const provider = () => {
    if (c.license.mode === "free")
      return {
        features: [...FREE_ENTITLEMENT.features],
        limits: { ...FREE_ENTITLEMENT.limits },
      };
    const at = now();
    try {
      if (at + 60 < trusted.lastTime) fail("LICENSE_CLOCK_ROLLBACK");
      const token = fs.readFileSync(c.license.tokenFile, "utf8").trim();
      const p = verifyEntitlement(
        token,
        c.license.keys,
        { tenant: c.tenant, device: c.id },
        at,
      );
      if (p.sequence < trusted.sequence) fail("LICENSE_REPLAY");
      trusted = {
        sequence: p.sequence,
        lastTime: Math.max(at, trusted.lastTime),
      };
      const tmp = licenseState + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(trusted), { mode: 0o600 });
      fs.renameSync(tmp, licenseState);
      // Persist the sequence BEFORE refusing: a revocation must raise the replay
      // high-water mark so an older ACTIVE token cannot be swapped back in.
      if (p.state === "REVOKED") fail("LICENSE_REVOKED");
      observe(p.state);
      return p;
    } catch (e) {
      if (
        c.license.fallbackToFree === true &&
        (e?.code === "LICENSE_EXPIRED" || e?.code === "LICENSE_REVOKED")
      ) {
        observe("FREE_FALLBACK", e.code);
        return {
          features: [...FREE_ENTITLEMENT.features],
          limits: { ...FREE_ENTITLEMENT.limits },
          state: "FREE_FALLBACK",
          reason: e.code,
        };
      }
      observe("DENIED", typeof e?.code === "string" ? e.code : "UNKNOWN");
      throw e;
    }
  };
  provider.trusted = () => trusted;
  return provider;
}
