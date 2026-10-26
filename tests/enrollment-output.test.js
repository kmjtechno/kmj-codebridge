import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { reserveEnrollmentOutput } from "../src/enrollment-output.js";

function withPrivateTemp(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codebridge-output-"));
  try {
    return callback(root, path.join(root, "agent.json"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("reserves before redeem and commits an exclusive private grant", () => {
  withPrivateTemp((_root, output) => {
    const reservation = reserveEnrollmentOutput(output);
    assert.equal(fs.readFileSync(output, "utf8"), "");
    const grant = { agent: { token: "secret-is-never-logged" } };
    reservation.commit(grant);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, "utf8")), grant);
    if (process.platform !== "win32")
      assert.equal(fs.statSync(output).mode & 0o777, 0o600);
    reservation.abort();
    assert.ok(fs.existsSync(output));
    assert.throws(() => reservation.commit(grant), {
      code: "ENROLLMENT_OUTPUT_UNAVAILABLE",
    });
  });
});

test("refuses to replace an existing grant or symlink", () => {
  withPrivateTemp((root, output) => {
    fs.writeFileSync(output, "original-protected-content");
    assert.throws(() => reserveEnrollmentOutput(output), {
      code: "ENROLLMENT_OUTPUT_EXISTS",
    });
    assert.equal(fs.readFileSync(output, "utf8"), "original-protected-content");
    fs.unlinkSync(output);
    const elsewhere = path.join(root, "existing");
    fs.writeFileSync(elsewhere, "unchanged");
    try {
      fs.symlinkSync(elsewhere, output, "file");
      assert.throws(() => reserveEnrollmentOutput(output), {
        code: "ENROLLMENT_OUTPUT_EXISTS",
      });
      assert.equal(fs.readFileSync(elsewhere, "utf8"), "unchanged");
    } catch (error) {
      if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    }
  });
});

test("failed directory preflight blocks enrollment and abort allows retry", () => {
  withPrivateTemp((root, output) => {
    assert.throws(
      () => reserveEnrollmentOutput(path.join(root, "missing", "agent.json")),
      { code: "ENROLLMENT_OUTPUT_UNAVAILABLE" },
    );
    const reservation = reserveEnrollmentOutput(output);
    assert.throws(() => reserveEnrollmentOutput(output), {
      code: "ENROLLMENT_OUTPUT_EXISTS",
    });
    reservation.abort();
    assert.equal(fs.existsSync(output), false);
    const retry = reserveEnrollmentOutput(output);
    retry.abort();
    assert.equal(fs.existsSync(output), false);
  });
});

test("detects replacement before writing a redeemed token", () => {
  withPrivateTemp((root, output) => {
    const reservation = reserveEnrollmentOutput(output);
    fs.renameSync(output, path.join(root, "moved-reservation"));
    fs.writeFileSync(output, "other-writer-data");
    assert.throws(
      () => reservation.commit({ agent: { token: "never-written" } }),
      { code: "ENROLLMENT_OUTPUT_WRITE_FAILED" },
    );
    assert.equal(fs.readFileSync(output, "utf8"), "other-writer-data");
  });
});
