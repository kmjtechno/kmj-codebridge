import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  TARGETS,
  VIEWPORTS,
  allowedTarget,
  chromeCandidates,
  assess,
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
  assert.ok(chromeCandidates("linux").every((v) => v.startsWith("/usr/bin/")));
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
