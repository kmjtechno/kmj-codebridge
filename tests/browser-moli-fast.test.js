import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MOLI_VERSION,
  parseMoliResult,
  selectedMoliBinary,
  fastBrowserProbe,
} from "../scripts/browser-moli-fast.mjs";

const expected = "https://kmjtechno.com/products";
const sample = () => JSON.stringify({
  final_url: expected,
  status: 200,
  html: "<html><body><main>Real public product content with many visible words.</main></body></html>",
});

test("Moli pin and JSON probe are explicit about actual URL/status", () => {
  assert.equal(MOLI_VERSION, "1.1.18");
  const data = parseMoliResult(sample(), expected);
  assert.equal(data.httpStatus, 200);
  assert.ok(data.htmlBytes > 40);
  assert.match(data.sha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(data).includes("Real public product"), false);
  assert.throws(() => parseMoliResult(sample(), "https://evil.example/products"), /MOLI_NAVIGATION_UNVERIFIED/);
  assert.throws(() => parseMoliResult(JSON.stringify({final_url: expected, status: 403, html: "<html>content</html>"}), expected), /MOLI_HTTP_NOT_200/);
  assert.throws(() => parseMoliResult("invalid JSON", expected), /MOLI_OUTPUT_INVALID/);
  assert.throws(() => parseMoliResult("[]", expected), /MOLI_OUTPUT_INVALID/);
  assert.throws(() => parseMoliResult(JSON.stringify({final_url: expected, status: 200, html: ""}), expected), /MOLI_EMPTY_BODY/);
});

test("Moli selection rejects symlink and missing candidates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-moli-binary-test-"));
  try {
    const real = path.join(root, "moli");
    const sym = path.join(root, "moli-link");
    fs.writeFileSync(real, "fake binary");
    fs.symlinkSync(real, sym);
    assert.equal(selectedMoliBinary([sym, real]), real);
    assert.equal(selectedMoliBinary([path.join(root, "missing")]), null);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("Moli fast lane stores bounded public metadata, never raw page HTML", {
  skip: process.platform !== "win32" && process.getuid?.() === 0,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-moli-qa-test-"));
  const output = path.join(root, "receipt");
  const seen = [];
  try {
    const result = await fastBrowserProbe("kmj_public", output, {
      moli: async (url) => {
        seen.push(url);
        return { httpStatus: 200, htmlBytes: 1024, sha256: "a".repeat(64) };
      },
      chrome: async () => { throw Error("CHROME_MUST_NOT_START"); },
    });
    assert.deepEqual(seen, [
      "https://kmjtechno.com/",
      "https://kmjtechno.com/products",
      "https://kmjtechno.com/login",
    ]);
    assert.equal(result.mode, "moli_semantic");
    assert.equal(result.verdict, "EXTRACTION_PASS");
    assert.equal(result.samples.length, 3);
    const receipt = fs.readFileSync(path.join(output, "receipt.json"), "utf8");
    assert.ok(!receipt.includes("<html"));
    assert.throws(() => fs.writeFileSync(path.join(output,"receipt.json"),"overwrite",{flag:"wx"}), /EEXIST/);
  } finally { fs.rmSync(root, {recursive:true,force:true}); }
});

test("Moli failure routes to Chrome but never hides Chrome FAIL", {
  skip: process.platform !== "win32" && process.getuid?.() === 0,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-moli-fallback-"));
  try {
    let chromeCalls = 0;
    const failed = await fastBrowserProbe("kmj_public", path.join(root, "failed"), {
      moli: async () => { throw Error("MOLI_NOT_INSTALLED"); },
      chrome: async (target, output) => {
        chromeCalls++;
        assert.equal(target, "kmj_public");
        assert.ok(output.endsWith(path.sep+"chrome"));
        return {verdict: "FAIL", samples:[{failures:["HTTP_NOT_200"]}], reason:"BROWSER_QA_FAILED"};
      },
    });
    assert.equal(failed.mode,"chrome_fidelity_fallback");
    assert.equal(failed.verdict, "FAIL");
    assert.equal(failed.fallbackReason, "MOLI_NOT_INSTALLED");
    assert.equal(chromeCalls, 1);

    const passed = await fastBrowserProbe("kmj_public", path.join(root, "passed"), {
      moli: async () => { throw Error("MOLI_NOT_INSTALLED"); },
      chrome: async () => ({verdict:"PASS",samples:Array(9).fill({failures:[]})}),
    });
    assert.equal(passed.verdict,"CHROME_QA_PASS");
    assert.equal(passed.chromeSamples, 9);
  } finally { fs.rmSync(root,{recursive:true,force:true}); }
});

test("unapproved target is rejected before any engine or output directory", async () => {
  const target = path.join(os.tmpdir(),"kmj-unexpected-target-not-created");
  await assert.rejects(fastBrowserProbe("internal_admin", target), /BROWSER_TARGET_NOT_ALLOWED/);
  assert.equal(fs.existsSync(target),false);
});

test("CodeBridge MCP fast probe shares bounded runner and does not expose arbitrary URLs", () => {
  const tools = fs.readFileSync(new URL("../src/tools.js", import.meta.url), "utf8");
  const source = fs.readFileSync(new URL("../scripts/browser-moli-fast.mjs", import.meta.url), "utf8");
  assert.match(tools, /browser_fast_probe:/);
  assert.match(tools, /if \(name === "browser_fast_probe"\)/);
  assert.match(tools, /gate: "browser-fast:kmj-public"/);
  assert.match(tools, /"kmj_public"/);
  assert.match(tools, /BROWSER_FAST_RUNTIME_NOT_DEPLOYED/);
  assert.match(source, /--block-private-networks/);
  assert.match(source, /--disable-subframes/);
  assert.doesNotMatch(source, /--no-sandbox|--remote-debugging-port|eval\(/);
});
