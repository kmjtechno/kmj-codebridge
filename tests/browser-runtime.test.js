import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chromeCandidates,
  moliCandidates,
  browserRuntimeStatus,
  selectInstalledBinary,
} from "../src/browser-runtime.js";
import { createChromePrivateEnvironment } from "../scripts/browser-public-qa.mjs";
import { createDispatcher } from "../src/tools.js";

test("engine discovery handles Windows, macOS and Linux without PATH execution", () => {
  const win = chromeCandidates("win32", {
    LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
  });
  assert.ok(win.some((p) => p.includes("Microsoft\\Edge")));
  assert.ok(win.some((p) => p.includes("Users\\tester")));
  assert.ok(win.every((p) => p.endsWith(".exe")));
  assert.equal(
    chromeCandidates("win32", { LOCALAPPDATA: "relative" }).length,
    4,
  );
  assert.ok(
    chromeCandidates("darwin").some((p) => p.includes("Google Chrome.app")),
  );
  assert.ok(chromeCandidates("linux").includes("/usr/bin/chromium"));
  assert.ok(chromeCandidates("linux").includes("/opt/google/chrome/chrome"));
  assert.deepEqual(chromeCandidates("unsupported"), []);
  assert.ok(moliCandidates("darwin")[0].endsWith("/moli"));
  assert.ok(moliCandidates("win32")[0].endsWith("moli.exe"));
});

test("engine selection rejects symlink binaries and avoids leaked executable paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-browser-choices-"));
  try {
    const program = path.join(root, "browser");
    const symlink = path.join(root, "browser-link");
    fs.writeFileSync(program, "fixture", { mode: 0o700 });
    fs.symlinkSync(program, symlink);
    assert.equal(selectInstalledBinary([symlink, program]), program);
    assert.equal(selectInstalledBinary([symlink]), null);
    assert.equal(selectInstalledBinary(["/missing"]), null);

    const stable = "/usr/bin/google-chrome";
    const fast = "/opt/kmj-codebridge-tools/moli/v1.1.18/bin/moli";
    const seen = new Set([stable, fast]);
    const status = browserRuntimeStatus({
      platform: "linux",
      lstat: (candidate) => {
        if (!seen.has(candidate)) throw Error("ENOENT");
        return fs.lstatSync(program);
      },
    });
    assert.equal(status.fidelity.available, true);
    assert.equal(status.fidelity.launchVerified, false);
    assert.equal(status.fast.available, true);
    assert.equal(status.fast.launchVerified, false);
    assert.equal(status.plan.textRead, "moli_then_chromium");
    assert.equal(status.plan.visualQa, "chromium");
    assert.equal(JSON.stringify(status).includes(root), false);
    assert.equal(JSON.stringify(status).includes(stable), false);
    assert.equal(status.localFirst, true);
    const missing = browserRuntimeStatus({
      platform: "linux",
      lstat: () => {
        throw Error("ENOENT");
      },
    });
    assert.equal(missing.plan.visualQa, "blocked_no_local_browser");
    assert.equal(missing.plan.textRead, "chromium_only");
    assert.equal(missing.fidelity.available, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser child environment excludes secrets and cloud credentials on all OSes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-browser-env-"));
  try {
    const parent = {
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      CODEBRIDGE_DEVICE_TOKEN: "do-not-pass-to-browser",
      AWS_SECRET_ACCESS_KEY: "do-not-pass-to-browser",
      OPENAI_API_KEY: "do-not-pass-to-browser",
      HTTP_PROXY: "http://unsafe-proxy.example",
      HOME: "/home/owner",
    };
    for (const platform of ["linux", "win32", "darwin"]) {
      const browserRoot = path.join(root, platform);
      fs.mkdirSync(browserRoot, { mode: 0o700 });
      const env = createChromePrivateEnvironment(
        browserRoot,
        parent,
        platform,
      );
      assert.equal(env.PATH, parent.PATH);
      assert.equal(env.CODEBRIDGE_DEVICE_TOKEN, undefined);
      assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.HTTP_PROXY, undefined);
      assert.ok(!JSON.stringify(env).includes("do-not-pass-to-browser"));
      assert.ok(!JSON.stringify(env).includes("/home/owner"));
      if (platform === "win32") {
        assert.ok(env.LOCALAPPDATA.startsWith(root));
        assert.ok(env.TEMP.startsWith(root));
      } else {
        assert.ok(env.XDG_CONFIG_HOME.startsWith(root));
        assert.ok(env.HOME.startsWith(root));
        assert.ok(env.TMPDIR.startsWith(root));
      }
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP browser readiness uses an authorized project and cannot launch a browser", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-browser-mcp-"));
  const root = path.join(home, "root");
  fs.mkdirSync(root);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dispatch = createDispatcher(
    {
      id: "device1",
      stateDir: home,
      projects: [
        { id: "project1", root, writable: false, gates: {}, commands: {} },
      ],
    },
    {
      run: () => {
        throw Error("BROWSER_MUST_NOT_EXECUTE");
      },
      maxConcurrent: 1,
    },
    () => ({ features: ["read"], limits: { concurrent_jobs: 1 } }),
  );
  const result = await dispatch(
    "browser_runtime_status",
    { device: "device1", project: "project1" },
    ["read"],
  );
  assert.equal(result.localFirst, true);
  assert.ok(result.plan);
  assert.ok(!JSON.stringify(result).includes("CODEBRIDGE_DEVICE_TOKEN"));
  await assert.rejects(
    dispatch(
      "browser_runtime_status",
      { device: "device1", project: "other" },
      ["read"],
    ),
  );
  await assert.rejects(
    dispatch(
      "browser_runtime_status",
      { device: "device1", project: "project1" },
      [],
    ),
  );
});
