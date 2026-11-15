import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mainPlatformLocalBackupEvidence } from "../src/main-platform-local-backup-evidence.js";
const NOW = Date.UTC(2026, 10, 15, 6, 0, 0);
const STAMP = "20261115T050000Z";
// Root-owned file modes and O_NOFOLLOW are POSIX contracts, not Windows emulation.
const linuxTest = process.platform === "linux" ? test : test.skip;
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-seq26-evidence-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const daily = path.join(base, "daily"),
    vault = path.join(base, "vault");
  fs.mkdirSync(daily, { mode: 0o700 });
  fs.mkdirSync(vault, { mode: 0o700 });
  const uid = process.getuid();
  const run = () =>
    mainPlatformLocalBackupEvidence({
      dailyRoot: daily,
      vaultRoot: vault,
      now: NOW,
      expectedUid: uid,
    });
  const addDaily = (stamp = STAMP) => {
    const d = path.join(daily, stamp);
    fs.mkdirSync(d, { mode: 0o700 });
    const dump = path.join(d, "platform.dump");
    fs.writeFileSync(
      dump,
      Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(100)]),
      { mode: 0o600 },
    );
    fs.utimesSync(dump, (NOW - 3600000) / 1000, (NOW - 3600000) / 1000);
    return dump;
  };
  const addCipher = (stamp = STAMP) => {
    const age = path.join(vault, stamp + ".tar.age");
    fs.writeFileSync(age, Buffer.alloc(128), { mode: 0o600 });
    fs.utimesSync(age, (NOW - 3600000) / 1000, (NOW - 3600000) / 1000);
    const side = path.join(vault, stamp + ".sha256");
    fs.writeFileSync(side, "a".repeat(64) + "  " + stamp + ".tar.age\n", {
      mode: 0o600,
    });
    return { age, side };
  };
  return { daily, vault, uid, run, addDaily, addCipher };
}
linuxTest(
  "fresh complete artifacts report presence but never claim restore or remote proof",
  (t) => {
    const f = fixture(t);
    f.addDaily();
    f.addCipher();
    const r = f.run();
    assert.equal(r.daily.format, "PGDMP");
    assert.equal(r.vault.sidecar, "FORMAT_PASS_HASH_NOT_COMPUTED");
    assert.equal(r.localHealthArtifactsFresh, true);
    assert.equal(r.exactHealthUnitExitVerified, false);
    assert.equal(r.remoteShaReadbackVerified, false);
    assert.equal(r.independentRestoreVerified, false);
    assert.equal(r.rootShellExecuted, false);
    assert.equal(r.mutations, "NONE");
    assert.doesNotMatch(
      JSON.stringify(r),
      /\/root\/|\.env|secret|privateKey|token/i,
    );
  },
);
linuxTest("missing local artifacts categorically fail without writes", (t) => {
  const f = fixture(t),
    r = f.run();
  assert.equal(r.daily.state, "MISSING");
  assert.equal(r.vault.state, "MISSING");
  assert.equal(r.localHealthArtifactsFresh, false);
});
linuxTest("stale daily artifact does not mask fresh cipher", (t) => {
  const f = fixture(t),
    dump = f.addDaily();
  f.addCipher();
  fs.utimesSync(dump, (NOW - 4 * 86400000) / 1000, (NOW - 4 * 86400000) / 1000);
  const r = f.run();
  assert.equal(r.daily.fresh, false);
  assert.equal(r.vault.fresh, true);
  assert.equal(r.localHealthArtifactsFresh, false);
});
linuxTest("symlinked daily root fails closed", (t) => {
  const f = fixture(t);
  f.addDaily();
  const other = path.join(path.dirname(f.daily), "link");
  fs.symlinkSync(f.daily, other);
  const r = mainPlatformLocalBackupEvidence({
    dailyRoot: other,
    vaultRoot: f.vault,
    now: NOW,
    expectedUid: f.uid,
  });
  assert.equal(r.daily.state, "UNVERIFIED");
  assert.equal(r.localHealthArtifactsFresh, false);
});
linuxTest("symlinked local dump fails closed", (t) => {
  const f = fixture(t);
  const dump = f.addDaily();
  fs.renameSync(dump, dump + ".orig");
  fs.symlinkSync(dump + ".orig", dump);
  assert.equal(f.run().daily.state, "UNVERIFIED");
});
linuxTest("hardlinked cipher fails closed", (t) => {
  const f = fixture(t);
  const { age } = f.addCipher();
  fs.linkSync(age, path.join(f.vault, "hardlink"));
  assert.equal(f.run().vault.state, "UNVERIFIED");
});
linuxTest("sidecar requires exact 91-byte two-space spelling", (t) => {
  const f = fixture(t);
  const { side } = f.addCipher();
  fs.writeFileSync(side, "a".repeat(64) + " " + STAMP + ".tar.age\n");
  assert.equal(f.run().vault.state, "UNVERIFIED");
});
linuxTest("sidecar missing remains a visible incomplete state", (t) => {
  const f = fixture(t);
  const { side } = f.addCipher();
  fs.unlinkSync(side);
  const r = f.run();
  assert.equal(r.vault.state, "PRESENT");
  assert.equal(r.vault.sidecar, "MISSING");
  assert.equal(r.vault.fresh, false);
  assert.equal(r.localHealthArtifactsFresh, false);
});
linuxTest("invalid calendar-like stamp cannot be counted", (t) => {
  const f = fixture(t);
  f.addDaily("20260230T050000Z");
  const r = f.run();
  assert.equal(r.daily.state, "MISSING");
});
linuxTest("no read-only status turns into health unit pass", (t) => {
  const f = fixture(t);
  f.addDaily();
  f.addCipher();
  const r = f.run();
  assert.equal(r.exactHealthUnitExitVerified, false);
  assert.equal(r.productionReleaseApproved, false);
});
