import test from "node:test";
import fs from "node:fs";

const nofollowSupported =
  Number.isInteger(fs.constants.O_NOFOLLOW) && fs.constants.O_NOFOLLOW !== 0;
import assert from "node:assert/strict";
import {
  readTrustedStageGatewayConfig,
  STAGE_GATEWAY_CONFIG,
} from "../src/stage-gateway-config.js";

const secret = '{"users":[],"token":"never-return-in-error"}';
const trustedDir = () => ({
  isDirectory: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  gid: 900,
  mode: 0o40750,
});
const trustedFile = () => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  gid: 900,
  nlink: 1,
  mode: 0o100640,
  size: Buffer.byteLength(secret),
  ino: 42,
  dev: 8,
});

function fixture({
  directory = trustedDir(),
  before = trustedFile(),
  after = before,
  data = secret,
} = {}) {
  const seen = [];
  let offset = 0;
  const io = {
    lstatSync: (path) => {
      seen.push(["lstat", path]);
      return path === STAGE_GATEWAY_CONFIG ? before : directory;
    },
    openSync: (path, flags) => {
      seen.push(["open", path, flags]);
      return 7;
    },
    fstatSync: (fd) => {
      assert.equal(fd, 7);
      return after;
    },
    readSync: (fd, buffer, start, length) => {
      assert.equal(fd, 7);
      const bytes = Buffer.from(data);
      const n = Math.min(length, bytes.length - offset);
      if (n > 0) bytes.copy(buffer, start, offset, offset + n);
      offset += n;
      return n;
    },
    closeSync: (fd) => {
      seen.push(["close", fd]);
    },
  };
  return { io, seen };
}

test(
  "fixed stage file is read only through nofollow, inode-pinned fd",
  { skip: !nofollowSupported },
  () => {
    const { io, seen } = fixture();
    assert.equal(readTrustedStageGatewayConfig({ io }), secret);
    assert.deepEqual(
      seen.filter(([op]) => op === "lstat").map(([, path]) => path),
      ["/etc/kmj-codebridge-stage", STAGE_GATEWAY_CONFIG],
    );
    assert.equal(seen.find(([op]) => op === "open")[1], STAGE_GATEWAY_CONFIG);
    assert.equal(seen.at(-1)[0], "close");
  },
);

test(
  "UID-bound nonroot stage service accepts only private matching 0700/0600 files",
  { skip: !nofollowSupported },
  () => {
    const serviceDirectory = { ...trustedDir(), uid: 997, gid: 997, mode: 0o40700 };
    const serviceFile = { ...trustedFile(), uid: 997, gid: 997, mode: 0o100600 };
    const { io } = fixture({ directory: serviceDirectory, before: serviceFile });
    assert.equal(readTrustedStageGatewayConfig({ io, serviceUid: 997 }), secret);
  },
);

test("nonroot service-owned credentials reject missing UID, mismatched owners, group/other read or traverse", () => {
  const dir = { ...trustedDir(), uid: 997, gid: 997, mode: 0o40700 };
  const file = { ...trustedFile(), uid: 997, gid: 997, mode: 0o100600 };
  const cases = [
    { directory: dir, before: file, serviceUid: null },
    { directory: dir, before: file, serviceUid: 998 },
    { directory: dir, before: file, serviceUid: 0 },
    { directory: dir, before: file, serviceUid: "997" },
    { directory: { ...dir, mode: 0o40750 }, before: file, serviceUid: 997 },
    { directory: { ...dir, mode: 0o40701 }, before: file, serviceUid: 997 },
    { directory: dir, before: { ...file, uid: 0 }, serviceUid: 997 },
    { directory: dir, before: { ...file, gid: 998 }, serviceUid: 997 },
    { directory: dir, before: { ...file, mode: 0o100640 }, serviceUid: 997 },
    { directory: dir, before: { ...file, mode: 0o100700 }, serviceUid: 997 },
    { directory: dir, before: { ...file, nlink: 2 }, serviceUid: 997 },
    { directory: dir, before: { ...file, isSymbolicLink: () => true }, serviceUid: 997 },
  ];
  for (const { serviceUid, ...scenario } of cases) {
    const { io, seen } = fixture(scenario);
    assert.throws(() => readTrustedStageGatewayConfig({ io, serviceUid }),
                  (e) => e.code === "CONFIG_TRUST_INVALID");
    assert.equal(seen.some(([op]) => op === "open"), false);
  }
});

test(
  "service-owned inode substitution still fails after secure open",
  { skip: !nofollowSupported },
  () => {
    const dir = { ...trustedDir(), uid: 997, gid: 997, mode: 0o40700 };
    const file = { ...trustedFile(), uid: 997, gid: 997, mode: 0o100600 };
    const { io, seen } = fixture({
      directory: dir, before: file, after: { ...file, ino: 100 },
    });
    assert.throws(() => readTrustedStageGatewayConfig({ io, serviceUid: 997 }),
                  (e) => e.code === "CONFIG_TRUST_INVALID");
    assert.equal(seen.at(-1)[0], "close");
  },
);

test("stage config rejects untrusted directory, symlink, hardlink and writable files before open", () => {
  const cases = [
    { directory: { ...trustedDir(), mode: 0o40777 } },
    { directory: { ...trustedDir(), mode: 0o40755 } },
    { directory: { ...trustedDir(), gid: undefined } },
    { directory: { ...trustedDir(), uid: 1000 } },
    { directory: { ...trustedDir(), isSymbolicLink: () => true } },
    { before: { ...trustedFile(), isSymbolicLink: () => true } },
    { before: { ...trustedFile(), nlink: 2 } },
    { before: { ...trustedFile(), uid: 1000 } },
    { before: { ...trustedFile(), mode: 0o100666 } },
    { before: { ...trustedFile(), mode: 0o100644 } },
    { before: { ...trustedFile(), mode: 0o100740 } },
    { before: { ...trustedFile(), gid: 901 } },
    { before: { ...trustedFile(), gid: undefined } },
    { before: { ...trustedFile(), size: 1024 * 1024 + 1 } },
  ];
  for (const scenario of cases) {
    const { io, seen } = fixture(scenario);
    assert.throws(
      () => readTrustedStageGatewayConfig({ io }),
      (error) => error.code === "CONFIG_TRUST_INVALID",
    );
    assert.equal(
      seen.some(([op]) => op === "open"),
      false,
    );
  }
});

test(
  "stage config rejects replacement inode after open and closes fd",
  { skip: !nofollowSupported },
  () => {
    const { io, seen } = fixture({
      after: { ...trustedFile(), ino: 43 },
    });
    assert.throws(
      () => readTrustedStageGatewayConfig({ io }),
      (error) => error.code === "CONFIG_TRUST_INVALID",
    );
    assert.equal(seen.at(-1)[0], "close");
  },
);

test(
  "stage config rejects growing content over fixed limit and closes fd",
  { skip: !nofollowSupported },
  () => {
    const { io, seen } = fixture({ data: "x".repeat(1024 * 1024 + 2) });
    assert.throws(
      () => readTrustedStageGatewayConfig({ io }),
      (error) => error.code === "CONFIG_TRUST_INVALID",
    );
    assert.equal(seen.at(-1)[0], "close");
  },
);

test(
  "stage reader never includes credential bytes in errors",
  { skip: !nofollowSupported },
  () => {
    const { io } = fixture({ after: { ...trustedFile(), uid: 1001 } });
    let message = "";
    try {
      readTrustedStageGatewayConfig({ io });
    } catch (error) {
      message = error.message;
    }
    assert.doesNotMatch(message, /never-return-in-error|token/);
  },
);
