// KMJ TECHNO — fixed-path read-only backup inventory for signed Seq26 successor.
// No retention execution, file deletion, key, restore, or remote transfer.
import fs from "node:fs";
import path from "node:path";

const DAILY = "/var/backups/kmj-elite-daily";
const VAULT = "/var/backups/kmj-elite-offsite-encrypted";
const STAMP = /^20[0-9]{6}T[0-9]{6}Z$/;
const SIDECAR = /^([a-f0-9]{64})  (20[0-9]{6}T[0-9]{6}Z\.tar\.age)\n$/;
const KEEP_PREVIEW = 34;
const MAX_ROOT_ENTRIES = 512;
const MAX_DUMP_BYTES = 8 * 1024 ** 3;
const AGE_HOUR = 3600000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function reject() {
  throw new Error("INVENTORY_NOT_ATTESTED");
}

export function validBackupStamp(name) {
  if (typeof name !== "string" || !STAMP.test(name)) return false;
  const y = Number(name.slice(0, 4));
  const m = Number(name.slice(4, 6));
  const d = Number(name.slice(6, 8));
  const h = Number(name.slice(9, 11));
  const min = Number(name.slice(11, 13));
  const s = Number(name.slice(13, 15));
  const t = new Date(Date.UTC(y, m - 1, d, h, min, s));
  return (
    t.getUTCFullYear() === y &&
    t.getUTCMonth() === m - 1 &&
    t.getUTCDate() === d &&
    t.getUTCHours() === h &&
    t.getUTCMinutes() === min &&
    t.getUTCSeconds() === s
  );
}

function assertPrivateRoot(root, uid, protectedRoot) {
  // Production parent components cannot be replaced by symlinks.
  if (root === protectedRoot) {
    for (const parent of ["/var", "/var/backups"]) {
      const p = fs.lstatSync(parent);
      if (
        !p.isDirectory() ||
        p.isSymbolicLink() ||
        p.uid !== 0 ||
        (p.mode & 0o022) !== 0
      ) reject();
    }
  }
  const st = fs.lstatSync(root);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== uid ||
    (st.mode & 0o022) !== 0
  ) reject();
  const fd = fs.openSync(
    root,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(fd);
    if (
      !opened.isDirectory() ||
      opened.dev !== st.dev ||
      opened.ino !== st.ino ||
      opened.uid !== uid
    ) reject();
  } finally {
    fs.closeSync(fd);
  }
}

function listed(root) {
  const items = fs.readdirSync(root);
  if (items.length > MAX_ROOT_ENTRIES) reject();
  return items;
}

function privateRegular(file, uid, minBytes, maxBytes) {
  const st = fs.lstatSync(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.uid !== uid ||
    (st.mode & 0o777) !== 0o600 ||
    st.nlink !== 1 ||
    st.size < minBytes ||
    st.size > maxBytes
  ) reject();
  return st;
}

function readBounded(file, uid, bytes) {
  const before = privateRegular(file, uid, bytes, bytes);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) reject();
    const data = Buffer.alloc(bytes);
    if (fs.readSync(fd, data, 0, bytes, 0) !== bytes) reject();
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(file);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      named.dev !== before.dev ||
      named.ino !== before.ino ||
      named.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      named.mtimeMs !== before.mtimeMs
    ) reject();
    return data;
  } finally {
    fs.closeSync(fd);
  }
}

function lastModifiedHours(st, now) {
  const age = (now - st.mtimeMs) / AGE_HOUR;
  return Number.isFinite(age) && age >= 0 ? Math.round(age * 10) / 10 : null;
}

function inspectDaily(root, uid, now) {
  assertPrivateRoot(root, uid, DAILY);
  const entryNames = listed(root);
  const timestamps = entryNames.filter(validBackupStamp).sort();
  const matched = [];
  let missingDumps = 0;
  for (const stamp of timestamps) {
    const directory = path.join(root, stamp);
    const st = fs.lstatSync(directory);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      st.uid !== uid ||
      (st.mode & 0o777) !== 0o700
    ) reject();
    const file = path.join(directory, "platform.dump");
    let dump;
    try {
      dump = privateRegular(file, uid, 32, MAX_DUMP_BYTES);
    } catch (error) {
      if (error?.code === "ENOENT") {
        missingDumps++;
        continue;
      }
      throw error;
    }
    // PGDMP signature only, not the database content or config files.
    const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    try {
      const opened = fs.fstatSync(fd);
      if (opened.ino !== dump.ino || opened.dev !== dump.dev) reject();
      const header = Buffer.alloc(5);
      if (fs.readSync(fd, header, 0, 5, 0) !== 5) reject();
      if (header.toString("ascii") !== "PGDMP") reject();
    } finally {
      fs.closeSync(fd);
    }
    matched.push({ stamp, mtimeMs: dump.mtimeMs });
  }
  const newest = matched.at(-1) ?? null;
  const newestAgeHours = newest
    ? lastModifiedHours({ mtimeMs: newest.mtimeMs }, now)
    : null;
  return {
    status: "INSPECTED",
    timestampedDirectoryCount: timestamps.length,
    validDumpCount: matched.length,
    missingDumpCount: missingDumps,
    unrelatedRootEntryCount: entryNames.length - timestamps.length,
    newestStamp: newest?.stamp ?? null,
    newestAgeHours,
    newestFresh: newestAgeHours !== null && newestAgeHours < 48,
    candidateStamps: matched.map((entry) => entry.stamp),
  };
}

function inspectVault(root, uid, now) {
  assertPrivateRoot(root, uid, VAULT);
  const entryNames = listed(root);
  const cipherStamps = new Set();
  const sidecarStamps = new Set();
  for (const name of entryNames) {
    if (name.endsWith(".tar.age") && validBackupStamp(name.slice(0, -8))) {
      const stamp = name.slice(0, -8);
      privateRegular(path.join(root, name), uid, 60, MAX_DUMP_BYTES);
      cipherStamps.add(stamp);
    } else if (
      name.endsWith(".sha256") &&
      validBackupStamp(name.slice(0, -7))
    ) {
      const stamp = name.slice(0, -7);
      const content = readBounded(path.join(root, name), uid, 91);
      const match = SIDECAR.exec(content.toString("ascii"));
      if (!match || match[2] !== stamp + ".tar.age") reject();
      sidecarStamps.add(stamp);
    }
  }
  const paired = Array.from(cipherStamps)
    .filter((stamp) => sidecarStamps.has(stamp))
    .sort();
  const newest = paired.at(-1) ?? null;
  const newestStat = newest
    ? fs.lstatSync(path.join(root, newest + ".tar.age"))
    : null;
  const newestAgeHours = newestStat
    ? lastModifiedHours(newestStat, now)
    : null;
  return {
    status: "INSPECTED",
    cipherCount: cipherStamps.size,
    sidecarCount: sidecarStamps.size,
    pairedCount: paired.length,
    cipherWithoutSidecarCount: Array.from(cipherStamps).filter(
      (stamp) => !sidecarStamps.has(stamp),
    ).length,
    sidecarWithoutCipherCount: Array.from(sidecarStamps).filter(
      (stamp) => !cipherStamps.has(stamp),
    ).length,
    unrelatedRootEntryCount:
      entryNames.length - cipherStamps.size - sidecarStamps.size,
    newestStamp: newest,
    newestAgeHours,
    newestFresh: newestAgeHours !== null && newestAgeHours < 48,
    sidecarFormatValidated: true,
    cipherDigestComparedToSidecar: false,
    recipientVerified: false,
    remoteRestoreVerified: false,
    candidateStamps: paired,
  };
}

export function mainPlatformBackupInventory({
  dailyRoot = DAILY,
  vaultRoot = VAULT,
  expectedUid = 0,
  now = Date.now(),
} = {}) {
  // Root Supervisor calls this without arguments. Overrides are only for
  // isolated tests; MCP callers cannot choose a path or runtime argument.
  let daily;
  let vault;
  try {
    daily = inspectDaily(dailyRoot, expectedUid, now);
  } catch {
    daily = { status: "BLOCKED", reason: "LOCAL_DAILY_NOT_ATTESTED" };
  }
  try {
    vault = inspectVault(vaultRoot, expectedUid, now);
  } catch {
    vault = { status: "BLOCKED", reason: "ENCRYPTED_VAULT_NOT_ATTESTED" };
  }

  const exact = daily.status === "INSPECTED" && vault.status === "INSPECTED";
  const clean =
    exact &&
    daily.missingDumpCount === 0 &&
    vault.cipherWithoutSidecarCount === 0 &&
    vault.sidecarWithoutCipherCount === 0;
  const oldestDaily = clean
    ? daily.candidateStamps.slice(0, Math.max(0, daily.validDumpCount - KEEP_PREVIEW))
    : [];
  const oldestVault = clean
    ? vault.candidateStamps.slice(0, Math.max(0, vault.pairedCount - KEEP_PREVIEW))
    : [];

  // Disclose ONLY bounded stamp names (timestamps, never arbitrary filenames).
  const resultDaily = { ...daily };
  const resultVault = { ...vault };
  delete resultDaily.candidateStamps;
  delete resultVault.candidateStamps;
  return {
    schema: "KMJ_FIXED_BACKUP_INVENTORY_V1",
    mode: "READ_ONLY",
    daily: resultDaily,
    vault: resultVault,
    correlation: {
      sameNewestStamp:
        exact &&
        Boolean(daily.newestStamp) &&
        daily.newestStamp === vault.newestStamp,
      localArtifactsFresh:
        exact && daily.newestFresh === true && vault.newestFresh === true,
    },
    retentionPreview: {
      fixedKeepCount: KEEP_PREVIEW,
      candidateDailyCount: oldestDaily.length,
      candidateCipherPairCount: oldestVault.length,
      exampleOldestDailyStamps: oldestDaily.slice(0, 3),
      exampleOldestCipherPairStamps: oldestVault.slice(0, 3),
      inspectionComplete: clean,
      policyApproved: false,
      deletionAuthorized: false,
    },
    healthUnitPassVerified: false,
    remoteSftpShaVerified: false,
    independentRestoreVerified: false,
    signedReleaseApproved: false,
    callerSelectedPaths: false,
    shellExecuted: false,
    filesOpenedForContentExceptHeadersAndSidecars: false,
    mutations: "NONE",
  };
}
