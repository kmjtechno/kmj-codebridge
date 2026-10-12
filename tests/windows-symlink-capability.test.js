import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tryFileSymlink } from "./windows-symlink-capability.js";

test("Windows symlink fixtures diagnose non-admin privilege without weakening CI", (t) => {
  if (process.platform !== "win32") {
    return t.skip("Windows permission behavior only");
  }
  t.mock.method(fs, "symlinkSync", () => {
    const error = new Error("fixture privilege unavailable");
    error.code = "EPERM";
    throw error;
  });
  const prior = process.env.CI;
  try {
    delete process.env.CI;
    assert.equal(tryFileSymlink(t, "target.txt", "link.txt"), false);
    process.env.CI = "true";
    assert.throws(
      () => tryFileSymlink(t, "target.txt", "link.txt"),
      /WINDOWS_CI_SYMLINK_PRIVILEGE_REQUIRED/,
    );
  } finally {
    if (prior === undefined) delete process.env.CI;
    else process.env.CI = prior;
  }
});

test("unexpected symlink creation errors are never masked", (t) => {
  t.mock.method(fs, "symlinkSync", () => {
    const error = new Error("disk unavailable");
    error.code = "ENOSPC";
    throw error;
  });
  assert.throws(
    () => tryFileSymlink(t, "target.txt", "link.txt"),
    /disk unavailable/,
  );
});
