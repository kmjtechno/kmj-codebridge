import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  TARGETS,
  VIEWPORTS,
  allowedTarget,
  chromeCandidates,
  assess,
  createChromePrivateEnvironment,
  measureAfterTextReady,
} from "../scripts/browser-public-qa.mjs";

test("browser test destinations and viewports are fixed", () => {
  assert.deepEqual(Object.keys(TARGETS), ["kmj_public"]);
  assert.deepEqual(TARGETS.kmj_public.paths, ["/", "/products", "/login"]);
  assert.equal(TARGETS.kmj_public.origin, "https://kmjtechno.com");
  assert.deepEqual(
    VIEWPORTS.map((v) => [v.name, v.width]),
    [
      ["desktop", 1440],
      ["tablet", 768],
      ["mobile", 390],
    ],
  );
  for (const origin of [
    "http://localhost:8080",
    "https://attacker.invalid",
    "file:///etc/passwd",
    "http://169.254.169.254",
    "__proto__",
  ])
    assert.throws(() => allowedTarget(origin), /BROWSER_TARGET_NOT_ALLOWED/);
  assert.ok(chromeCandidates("win32").every((v) => v.endsWith(".exe")));
  assert.ok(chromeCandidates("linux").every((v) => path.posix.isAbsolute(v)));
});
test("browser QA fails for bad navigation, blank pages, JS or layout defects", () => {
  const good = {
    actualUrl: "https://kmjtechno.com/products",
    expectedUrl: "https://kmjtechno.com/products",
    httpStatus: 200,
    bodyLength: 210,
    overflowPx: 0,
    brokenImages: 0,
    exceptions: 0,
  };
  assert.deepEqual(assess(good), []);
  assert.deepEqual(
    assess({
      ...good,
      actualUrl: "https://other.invalid",
      httpStatus: 404,
      bodyLength: 0,
      overflowPx: 19,
      brokenImages: 2,
      exceptions: 1,
    }),
    [
      "UNEXPECTED_NAVIGATION",
      "HTTP_NOT_200",
      "BLANK_PAGE",
      "BROKEN_IMAGES",
      "JS_EXCEPTIONS",
      "HORIZONTAL_OVERFLOW",
    ],
  );
});
test("CodeBridge browser MCP tools use the existing nonblocking runner", () => {
  const src = fs.readFileSync("src/tools.js", "utf8");
  const browser = fs.readFileSync("scripts/browser-public-qa.mjs", "utf8");
  assert.match(src, /browser_qa_start:/);
  assert.match(src, /browser_qa_receipt:/);
  assert.match(src, /if \(p\.id !== "kmj-main-platform" \|\| !p\.writable\)/);
  assert.match(src, /gate: "browser-qa:kmj-public"/);
  assert.match(src, /return runner\.run\(\{/);
  assert.match(src, /fileURLToPath\(/);
  assert.match(
    src,
    /runner\.jobs\.get\(a\.job\) \?\? runner\.archive\.get\(a\.job\)/,
  );
  assert.match(src, /actual !== sample\.sha256/);
  assert.match(browser, /--remote-debugging-pipe/);
  assert.match(browser, /--user-data-dir=/);
  // Unsettled lazy images must never be reported as successfully loaded.
  assert.match(browser, /filter\(i=>!i\.complete\|\|!i\.naturalWidth\)/);
  assert.match(browser, /awaitPromise: true/);
  assert.match(browser, /image\.loading===\x27lazy\x27/);
  assert.match(
    browser,
    /if \(process\.platform !== "win32" && process\.getuid\?\.\(\) === 0\)/,
  );
  assert.doesNotMatch(browser, /--no-sandbox|--remote-debugging-port/);
  assert.doesNotMatch(src, /execFileSync\("chrome"/);
  assert.doesNotMatch(
    browser,
    /process\.env\.(?:PASSWORD|TOKEN|COOKIE|SECRET)/,
  );
});

test("Chrome receives isolated writable HOME and XDG dirs under hardened agents", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-browser-env-test-"));
  try {
    const inheritedHome = process.env.HOME;
    const env = createChromePrivateEnvironment(root, {
      HOME: "/restricted/service/home",
      XDG_CONFIG_HOME: "/restricted/config",
      XDG_CACHE_HOME: "/restricted/cache",
      PATH: "/usr/bin:/bin",
    });
    assert.deepEqual(
      [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME],
      [
        path.join(root, "home"),
        path.join(root, "config"),
        path.join(root, "cache"),
      ],
    );
    assert.equal(env.PATH, "/usr/bin:/bin");
    for (const directory of [
      env.HOME,
      env.XDG_CONFIG_HOME,
      env.XDG_CACHE_HOME,
    ]) {
      const stat = fs.statSync(directory);
      assert.ok(stat.isDirectory());
      if (process.platform !== "win32") assert.equal(stat.mode & 0o077, 0);
    }
    assert.equal(process.env.HOME, inheritedHome);
    const source = fs.readFileSync("scripts/browser-public-qa.mjs", "utf8");
    assert.match(source, /env: chromeEnv/);
    assert.match(source, /fs\.rmSync\(profileRoot/);
    assert.doesNotMatch(source, /--no-sandbox|--remote-debugging-port/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("browser readiness waits for hydrated text without suppressing genuine blank pages", async () => {
  let now = 0;
  let attempts = 0;
  const hydrated = await measureAfterTextReady(
    async () => ({ bodyLength: [0, 0, 15055][attempts++] }),
    {
      timeoutMs: 400,
      pollMs: 100,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  assert.equal(hydrated.bodyLength, 15055);
  assert.equal(attempts, 3);
  assert.equal(now, 200);

  now = 0;
  attempts = 0;
  const trulyBlank = await measureAfterTextReady(
    async () => {
      attempts++;
      return { bodyLength: 0 };
    },
    {
      timeoutMs: 400,
      pollMs: 200,
      clock: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  assert.equal(trulyBlank.bodyLength, 0);
  assert.equal(attempts, 3);
  assert.equal(now, 400);
  assert.deepEqual(
    assess({
      actualUrl: "https://kmjtechno.com/products",
      expectedUrl: "https://kmjtechno.com/products",
      httpStatus: 200,
      bodyLength: trulyBlank.bodyLength,
      overflowPx: 0,
      brokenImages: 0,
      exceptions: 0,
    }),
    ["BLANK_PAGE"],
  );
});

test("browser compatibility profile uses captured commands without widening execution", () => {
  const src = fs.readFileSync("src/tools.js", "utf8");
  assert.match(src, /a\.command === "browser_public_qa"/);
  assert.match(src, /a\.variant !== "start"/);
  assert.match(src, /a\.laneId !== undefined/);
  assert.match(src, /a\.expectedHead !== undefined/);
  assert.match(src, /p\.id !== "kmj-main-platform" \|\| !p\.writable/);
  assert.match(src, /gate: "browser-qa:kmj-public"/);
  assert.match(src, /command: process\.execPath/);
  assert.match(src, /"kmj_public"/);
  assert.match(src, /timeoutMs: 120000/);
});
