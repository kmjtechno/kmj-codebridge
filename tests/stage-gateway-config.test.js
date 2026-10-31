import test from "node:test";
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
  mode: 0o40750,
});
const trustedFile = () => ({
  isFile: () => true,
  isSymbolicLink: () => false,
  uid: 0,
  nlink: 1,
  mode: 0o100640,
  size: Buffer.byteLength(secret),
  ino: 42,
  dev: 8,
});

function fixture({ directory = trustedDir(), before = trustedFile(), after = before, data = secret } = {}) {
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

test("fixed stage file is read only through nofollow, inode-pinned fd", () => {
  const { io, seen } = fixture();
  assert.equal(readTrustedStageGatewayConfig({ io }), secret);
  assert.deepEqual(
    seen.filter(([op]) => op === "lstat").map(([, path]) => path),
    ["/etc/kmj-codebridge-stage", STAGE_GATEWAY_CONFIG],
  );
  assert.equal(seen.find(([op]) => op === "open")[1], STAGE_GATEWAY_CONFIG);
  assert.equal(seen.at(-1)[0], "close");
});

test("stage config rejects untrusted directory, symlink, hardlink and writable files before open", () => {
  const cases = [
    { directory: { ...trustedDir(), mode: 0o40777 } },
    { directory: { ...trustedDir(), uid: 1000 } },
    { directory: { ...trustedDir(), isSymbolicLink: () => true } },
    { before: { ...trustedFile(), isSymbolicLink: () => true } },
    { before: { ...trustedFile(), nlink: 2 } },
    { before: { ...trustedFile(), uid: 1000 } },
    { before: { ...trustedFile(), mode: 0o100666 } },
    { before: { ...trustedFile(), size: 1024 * 1024 + 1 } },
  ];
  for (const scenario of cases) {
    const { io, seen } = fixture(scenario);
    assert.throws(
      () => readTrustedStageGatewayConfig({ io }),
      (error) => error.code === "CONFIG_TRUST_INVALID",
    );
    assert.equal(seen.some(([op]) => op === "open"), false);
  }
});

test("stage config rejects replacement inode after open and closes fd", () => {
  const { io, seen } = fixture({
    after: { ...trustedFile(), ino: 43 },
  });
  assert.throws(
    () => readTrustedStageGatewayConfig({ io }),
    (error) => error.code === "CONFIG_TRUST_INVALID",
  );
  assert.equal(seen.at(-1)[0], "close");
});

test("stage config rejects growing content over fixed limit and closes fd", () => {
  const { io, seen } = fixture({ data: "x".repeat(1024 * 1024 + 2) });
  assert.throws(
    () => readTrustedStageGatewayConfig({ io }),
    (error) => error.code === "CONFIG_TRUST_INVALID",
  );
  assert.equal(seen.at(-1)[0], "close");
});

test("stage reader never includes credential bytes in errors", () => {
  const { io } = fixture({ after: { ...trustedFile(), uid: 1001 } });
  let message = "";
  try {
    readTrustedStageGatewayConfig({ io });
  } catch (error) {
    message = error.message;
  }
  assert.doesNotMatch(message, /never-return-in-error|token/);
});
