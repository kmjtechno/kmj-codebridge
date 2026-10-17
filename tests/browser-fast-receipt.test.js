import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { verifiedFastReceipt } from "../src/browser-fast-receipt.js";

const paths = ["/", "/products", "/login"];
const views = ["desktop", "tablet", "mobile"];
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "kmj-fast-proof-"));
const json = (p, value) => fs.writeFileSync(p, JSON.stringify(value));

const extraction = () => ({
  schema: "kmj-browser-fast-v1",
  target: "kmj_public",
  mode: "moli_semantic",
  verdict: "EXTRACTION_PASS",
  samples: paths.map((p) => ({
    path: p,
    httpStatus: 200,
    htmlBytes: 200,
    sha256: "c".repeat(64),
    elapsedMs: 5,
  })),
});

test("verified extraction reports only fixed metadata without page HTML", () => {
  const root = tmp();
  try {
    json(path.join(root, "receipt.json"), extraction());
    const proof = verifiedFastReceipt(root);
    assert.equal(proof.verified, true);
    assert.equal(proof.verdict, "EXTRACTION_PASS");
    assert.deepEqual(
      proof.samples.map((s) => s.path),
      paths,
    );
    assert.equal(JSON.stringify(proof).includes("<html"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("faked extraction PASS with missing, repeated, malformed or redirected page fails", () => {
  const root = tmp();
  try {
    for (const edit of [
      (v) => v.samples.pop(),
      (v) => (v.samples[1].path = v.samples[0].path),
      (v) => (v.samples[0].sha256 = "not-a-hash"),
      (v) => (v.samples[1].httpStatus = 403),
      (v) => (v.samples[1].htmlBytes = -1),
    ]) {
      const v = extraction();
      edit(v);
      json(path.join(root, "receipt.json"), v);
      assert.throws(
        () => verifiedFastReceipt(root),
        /BROWSER_FAST_RECEIPT_INVALID/,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Chrome fallback PASS verifies all nine screenshot hashes", () => {
  const root = tmp();
  try {
    const chromeDir = path.join(root, "chrome");
    fs.mkdirSync(chromeDir);
    const samples = [];
    for (const viewport of views) {
      for (const page of paths) {
        const name =
          viewport + "-" + (page === "/" ? "home" : page.slice(1)) + ".png";
        const bytes = Buffer.alloc(96, 1);
        fs.writeFileSync(path.join(chromeDir, name), bytes);
        samples.push({
          viewport,
          path: page,
          screenshot: name,
          failures: [],
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
    }
    json(path.join(chromeDir, "receipt.json"), {
      schema: "kmj-browser-v1",
      target: "kmj_public",
      verdict: "PASS",
      samples,
    });
    json(path.join(root, "receipt.json"), {
      schema: "kmj-browser-fast-v1",
      target: "kmj_public",
      mode: "chrome_fidelity_fallback",
      verdict: "CHROME_QA_PASS",
      chromeVerdict: "PASS",
      chromeSamples: 9,
      samples: [],
    });
    const proof = verifiedFastReceipt(root);
    assert.equal(proof.verdict, "CHROME_QA_PASS");
    assert.equal(proof.samples.length, 9);
    fs.writeFileSync(
      path.join(chromeDir, "desktop-home.png"),
      Buffer.alloc(96, 2),
    );
    assert.throws(
      () => verifiedFastReceipt(root),
      /BROWSER_FAST_RECEIPT_INVALID/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "receipt path symlink is rejected",
  { skip: process.platform === "win32" },
  () => {
    const root = tmp();
    try {
      const actual = path.join(root, "real.json");
      json(actual, extraction());
      fs.symlinkSync(actual, path.join(root, "receipt.json"));
      assert.throws(
        () => verifiedFastReceipt(root),
        /BROWSER_FAST_RECEIPT_INVALID/,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

test("CodeBridge exposes the project-scoped receipt under existing job status", () => {
  const src = fs.readFileSync(
    new URL("../src/tools.js", import.meta.url),
    "utf8",
  );
  assert.match(src, /browser_fast_probe_receipt:/);
  assert.match(src, /if \(name === "browser_fast_probe_receipt"\)/);
  assert.match(src, /job\.gate !== "browser-fast:kmj-public"/);
  assert.match(src, /browserFastReceipt: receipt/);
  assert.match(src, /timeoutMs: 180000/);
});
