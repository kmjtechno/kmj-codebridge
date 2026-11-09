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

test("REA doctor opt-in inherits only validated absolute provider directories on Windows", () => {
  const source = {
    PATH: "C:\\Windows\\System32",
    SystemRoot: "C:\\Windows",
    JAVA_HOME: "C:\\Program Files\\Eclipse Adoptium\\jdk-25",
    GHIDRA_INSTALL_DIR: "C:\\Users\\operator\\tools\\ghidra_12.1.4_PUBLIC",
    REA_SECRET_KEY: "private",
  };
  const defaultEnv = jobEnvironment(source, "win32");
  assert.equal(Object.hasOwn(defaultEnv, "JAVA_HOME"), false);
  assert.equal(Object.hasOwn(defaultEnv, "GHIDRA_INSTALL_DIR"), false);
  const doctorEnv = jobEnvironment(source, "win32", {
    allowReaProviderPaths: true,
  });
  assert.equal(doctorEnv.JAVA_HOME, source.JAVA_HOME);
  assert.equal(doctorEnv.GHIDRA_INSTALL_DIR, source.GHIDRA_INSTALL_DIR);
  assert.equal(Object.hasOwn(doctorEnv, "REA_SECRET_KEY"), false);
  const linuxEnv = jobEnvironment(source, "linux", {
    allowReaProviderPaths: true,
  });
  assert.equal(Object.hasOwn(linuxEnv, "JAVA_HOME"), false);
});

test("REA doctor opt-in refuses relative, control-character and oversized provider roots", () => {
  const env = jobEnvironment(
    {
      PATH: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      JAVA_HOME: "java",
      GHIDRA_INSTALL_DIR:
        "C:\\Users\\operator\\tools\\ghidra" + String.fromCharCode(10),
    },
    "win32",
    { allowReaProviderPaths: true },
  );
  assert.equal(Object.hasOwn(env, "JAVA_HOME"), false);
  assert.equal(Object.hasOwn(env, "GHIDRA_INSTALL_DIR"), false);
  const longEnv = jobEnvironment(
    {
      PATH: "",
      SystemRoot: "C:\\Windows",
      JAVA_HOME: "C:\\" + "a".repeat(5000),
    },
    "win32",
    { allowReaProviderPaths: true },
  );
  assert.equal(Object.hasOwn(longEnv, "JAVA_HOME"), false);
});

test("CMAKE_PREFIX_PATH is inherited only by approved cmake commands and only when safe", () => {
  const base = { PATH: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" };
  const good = "C:\\Qt\\6.10.3\\msvc2022_64;D:\\libs\\opencv";
  const withPrefix = { ...base, CMAKE_PREFIX_PATH: good };
  assert.equal(
    Object.hasOwn(jobEnvironment(withPrefix, "win32"), "CMAKE_PREFIX_PATH"),
    false,
  );
  assert.equal(
    jobEnvironment(withPrefix, "win32", { allowCmakePrefixPath: true })
      .CMAKE_PREFIX_PATH,
    good,
  );
  assert.equal(
    Object.hasOwn(
      jobEnvironment(withPrefix, "linux", { allowCmakePrefixPath: true }),
      "CMAKE_PREFIX_PATH",
    ),
    false,
  );
  for (const bad of [
    "relative\\qt",
    "C:\\Qt;..\\evil",
    "C:\\Qt\\..\\evil",
    "C:\\Qt" + String.fromCharCode(10) + "x",
    "C:\\" + "a".repeat(5000),
    ";;",
  ]) {
    assert.equal(
      Object.hasOwn(
        jobEnvironment({ ...base, CMAKE_PREFIX_PATH: bad }, "win32", {
          allowCmakePrefixPath: true,
        }),
        "CMAKE_PREFIX_PATH",
      ),
      false,
      bad.slice(0, 20),
    );
  }
});
