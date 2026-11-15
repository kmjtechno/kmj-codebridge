import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mainPlatformBackupInventory,
  validBackupStamp,
} from "../src/main-platform-backup-inventory.js";

const linuxTest = process.platform === "linux" ? test : test.skip;
const NOW = Date.UTC(2026, 10, 15, 6, 0, 0);
const stamp = (day) => "202611" + String(day).padStart(2, "0") + "T050000Z";
function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-backup-inventory-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const daily = path.join(base, "daily");
  const vault = path.join(base, "vault");
  fs.mkdirSync(daily, { mode: 0o700 });
  fs.mkdirSync(vault, { mode: 0o700 });
  const uid = process.getuid();
  const inspect = () =>
    mainPlatformBackupInventory({
      dailyRoot: daily,
      vaultRoot: vault,
      expectedUid: uid,
      now: NOW,
    });
  const addDaily = (s = stamp(15), { dump = true } = {}) => {
    const dir = path.join(daily, s);
    fs.mkdirSync(dir, { mode: 0o700 });
    if (!dump) return { dir };
    const file = path.join(dir, "platform.dump");
    fs.writeFileSync(
      file,
      Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(128)]),
      { mode: 0o600 },
    );
    fs.utimesSync(file, (NOW - 3600000) / 1000, (NOW - 3600000) / 1000);
    return { dir, file };
  };
  const addPair = (s = stamp(15), { cipher = true, sidecar = true } = {}) => {
    const age = path.join(vault, s + ".tar.age");
    const checksum = path.join(vault, s + ".sha256");
    if (cipher) {
      fs.writeFileSync(age, Buffer.alloc(128), { mode: 0o600 });
      fs.utimesSync(age, (NOW - 3600000) / 1000, (NOW - 3600000) / 1000);
    }
    if (sidecar) {
      fs.writeFileSync(checksum, "a".repeat(64) + "  " + s + ".tar.age\n", {
        mode: 0o600,
      });
    }
    return { age, checksum };
  };
  return { daily, vault, base, inspect, addDaily, addPair, uid };
}

linuxTest(
  "empty fixed roots do not claim restore, unit success, or deletion",
  (t) => {
    const f = fixture(t);
    const r = f.inspect();
    assert.equal(r.daily.validDumpCount, 0);
    assert.equal(r.vault.pairedCount, 0);
    assert.equal(r.correlation.localArtifactsFresh, false);
    assert.equal(r.retentionPreview.deletionAuthorized, false);
    assert.equal(r.retentionPreview.policyApproved, false);
    assert.equal(r.remoteSftpShaVerified, false);
    assert.equal(r.independentRestoreVerified, false);
    assert.equal(r.healthUnitPassVerified, false);
    assert.equal(r.shellExecuted, false);
    assert.equal(r.mutations, "NONE");
  },
);

linuxTest(
  "fresh matched daily and cipher pair report aligned stamps, not restore",
  (t) => {
    const f = fixture(t);
    f.addDaily();
    f.addPair();
    const r = f.inspect();
    assert.equal(r.daily.validDumpCount, 1);
    assert.equal(r.vault.pairedCount, 1);
    assert.equal(r.correlation.sameNewestStamp, true);
    assert.equal(r.correlation.localArtifactsFresh, true);
    assert.equal(r.vault.cipherDigestComparedToSidecar, false);
    assert.equal(r.vault.remoteRestoreVerified, false);
    assert.equal(r.retentionPreview.candidateDailyCount, 0);
    assert.equal(r.retentionPreview.candidateCipherPairCount, 0);
  },
);

linuxTest(
  "35 matched copies give exactly one preview per fixed root, no deletion",
  (t) => {
    const f = fixture(t);
    const dates = [];
    for (let day = 1; day <= 30; day++) dates.push(stamp(day));
    for (let day = 1; day <= 5; day++)
      dates.push("202610" + String(day).padStart(2, "0") + "T050000Z");
    for (const value of dates) {
      f.addDaily(value);
      f.addPair(value);
    }
    const before = fs.readdirSync(f.daily).length;
    const r = f.inspect();
    assert.equal(r.daily.validDumpCount, 35);
    assert.equal(r.vault.pairedCount, 35);
    assert.equal(r.retentionPreview.fixedKeepCount, 34);
    assert.equal(r.retentionPreview.candidateDailyCount, 1);
    assert.equal(r.retentionPreview.candidateCipherPairCount, 1);
    assert.equal(
      r.retentionPreview.exampleOldestDailyStamps[0],
      "20261001T050000Z",
    );
    assert.equal(
      r.retentionPreview.exampleOldestCipherPairStamps[0],
      "20261001T050000Z",
    );
    assert.equal(fs.readdirSync(f.daily).length, before);
    assert.equal(r.retentionPreview.deletionAuthorized, false);
  },
);

linuxTest(
  "stale daily PGDMP never becomes healthy because vault is fresh",
  (t) => {
    const f = fixture(t);
    const { file } = f.addDaily();
    f.addPair();
    fs.utimesSync(
      file,
      (NOW - 4 * 86400000) / 1000,
      (NOW - 4 * 86400000) / 1000,
    );
    const r = f.inspect();
    assert.equal(r.daily.newestFresh, false);
    assert.equal(r.vault.newestFresh, true);
    assert.equal(r.correlation.localArtifactsFresh, false);
  },
);

linuxTest(
  "latest stamp mismatch is reported without asserting backup corruption",
  (t) => {
    const f = fixture(t);
    f.addDaily(stamp(14));
    f.addPair(stamp(15));
    const r = f.inspect();
    assert.equal(r.correlation.sameNewestStamp, false);
    assert.equal(r.retentionPreview.policyApproved, false);
  },
);

linuxTest(
  "cipher orphan blocks retention preview and remains visible as count only",
  (t) => {
    const f = fixture(t);
    f.addPair(stamp(15), { sidecar: false });
    const r = f.inspect();
    assert.equal(r.vault.cipherWithoutSidecarCount, 1);
    assert.equal(r.retentionPreview.inspectionComplete, false);
    assert.deepEqual(r.retentionPreview.exampleOldestCipherPairStamps, []);
  },
);

linuxTest(
  "sidecar orphan blocks preview without following unrelated paths",
  (t) => {
    const f = fixture(t);
    f.addPair(stamp(15), { cipher: false });
    const r = f.inspect();
    assert.equal(r.vault.sidecarWithoutCipherCount, 1);
    assert.equal(r.retentionPreview.inspectionComplete, false);
  },
);

linuxTest(
  "missing daily dump is classified and blocks candidate preview",
  (t) => {
    const f = fixture(t);
    f.addDaily(stamp(15), { dump: false });
    const r = f.inspect();
    assert.equal(r.daily.missingDumpCount, 1);
    assert.equal(r.retentionPreview.inspectionComplete, false);
    assert.equal(r.retentionPreview.deletionAuthorized, false);
  },
);

linuxTest(
  "bad sidecar spelling blocks vault, not daily, and reveals no path",
  (t) => {
    const f = fixture(t);
    f.addDaily();
    const { checksum } = f.addPair();
    fs.writeFileSync(checksum, "a".repeat(64) + " " + stamp(15) + ".tar.age\n");
    const r = f.inspect();
    assert.equal(r.daily.status, "INSPECTED");
    assert.equal(r.vault.status, "BLOCKED");
    assert.equal(r.retentionPreview.inspectionComplete, false);
    assert.doesNotMatch(
      JSON.stringify(r),
      new RegExp(f.base.replaceAll("\\", "\\\\")),
    );
  },
);

linuxTest("unsafe symlinked vault root is fail-closed", (t) => {
  const f = fixture(t);
  const target = f.vault + ".real";
  fs.renameSync(f.vault, target);
  fs.symlinkSync(target, f.vault);
  const r = f.inspect();
  assert.equal(r.vault.status, "BLOCKED");
  assert.equal(r.retentionPreview.deletionAuthorized, false);
});

linuxTest("hardlinked cipher or symlinked signed sidecar is rejected", (t) => {
  const f = fixture(t);
  const { age, checksum } = f.addPair();
  fs.linkSync(age, f.vault + ".hardlink");
  assert.equal(f.inspect().vault.status, "BLOCKED");
  fs.unlinkSync(f.vault + ".hardlink");
  const target = checksum + ".real";
  fs.renameSync(checksum, target);
  fs.symlinkSync(target, checksum);
  assert.equal(f.inspect().vault.status, "BLOCKED");
});

linuxTest("regular unrelated entries are never selected for deletion", (t) => {
  const f = fixture(t);
  f.addDaily();
  f.addPair();
  fs.writeFileSync(path.join(f.daily, "private-unrelated"), "no delete");
  fs.writeFileSync(path.join(f.vault, "orphan.tmp"), "no delete");
  const r = f.inspect();
  assert.equal(r.daily.unrelatedRootEntryCount, 1);
  assert.equal(r.vault.unrelatedRootEntryCount, 1);
  assert.equal(r.retentionPreview.deletionAuthorized, false);
  assert.equal(
    fs.readFileSync(path.join(f.vault, "orphan.tmp"), "utf8"),
    "no delete",
  );
});

linuxTest(
  "invalid calendar stamps cannot count as valid retention candidates",
  (t) => {
    const f = fixture(t);
    f.addDaily("20260230T050000Z");
    f.addPair("20260230T050000Z");
    assert.equal(validBackupStamp("20260230T050000Z"), false);
    assert.equal(validBackupStamp("../20261115T050000Z"), false);
    const r = f.inspect();
    assert.equal(r.daily.validDumpCount, 0);
    assert.equal(r.vault.pairedCount, 0);
  },
);

linuxTest("wrong owner mode on dump blocks daily evidence", (t) => {
  const f = fixture(t);
  const { file } = f.addDaily();
  fs.chmodSync(file, 0o644);
  const r = f.inspect();
  assert.equal(r.daily.status, "BLOCKED");
  assert.equal(r.vault.status, "INSPECTED");
});

linuxTest(
  "a sidecar that does not match cipher SHA is not falsely attested",
  (t) => {
    const f = fixture(t);
    f.addPair();
    const r = f.inspect();
    assert.equal(r.vault.sidecarFormatValidated, true);
    assert.equal(r.vault.cipherDigestComparedToSidecar, false);
    assert.equal(r.remoteSftpShaVerified, false);
  },
);
