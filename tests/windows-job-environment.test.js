import test from "node:test";
import assert from "node:assert/strict";
import { jobEnvironment } from "../src/jobs.js";

test("native Windows build jobs receive only standard OS directories", () => {
  const source = {
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    USERPROFILE: "C:\\Users\\operator",
    APPDATA: "C:\\Users\\operator\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\operator\\AppData\\Local",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\operator",
    MY_APP_SECRET: "private-value",
    OPENAI_API_KEY: "private-value",
    PSModulePath: "C:\\UntrustedModules",
  };
  const win = jobEnvironment(source, "win32");
  assert.equal(win.TEMP, "C:\\Temp");
  assert.equal(win.APPDATA, source.APPDATA);
  assert.equal(win.SystemRoot, "C:\\Windows");
  assert.equal(win.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
  assert.equal(win.windir, "C:\\Windows");
  assert.equal(win.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(win.CI, "true");
  assert.equal(win.LANG, "C.UTF-8");
  assert.equal(Object.hasOwn(win, "MY_APP_SECRET"), false);
  assert.equal(Object.hasOwn(win, "OPENAI_API_KEY"), false);
  assert.deepEqual(
    Object.keys(jobEnvironment(source, "linux")).sort(),
    ["PATH", "SystemRoot", "LANG", "CI"].sort(),
  );
});

test("native path allowlist rejects control characters and huge inherited values", () => {
  const env = jobEnvironment(
    {
      PATH: "",
      SystemRoot: "C:\\Windows",
      TEMP: "C:\\Temp" + String.fromCharCode(10),
      TMP: "x".repeat(5000),
      USERPROFILE: "C:\\Users\\operator",
    },
    "win32",
  );
  assert.equal(Object.hasOwn(env, "TEMP"), false);
  assert.equal(Object.hasOwn(env, "TMP"), false);
  assert.equal(env.USERPROFILE, "C:\\Users\\operator");
});
