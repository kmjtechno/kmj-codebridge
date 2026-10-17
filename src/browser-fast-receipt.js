// Verify private Moli extraction and Chrome fidelity receipts without returning HTML.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const PATHS = ["/", "/products", "/login"];
const VIEWS = ["desktop", "tablet", "mobile"];
const VALID_SHA = /^[a-f0-9]{64}$/;

function readSmallJson(file) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size < 2 || st.size > 32768)
    throw Error("BROWSER_FAST_RECEIPT_INVALID");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function verifiedFastReceipt(directory) {
  try {
    const root = fs.lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw Error("INVALID_DIRECTORY");
    const data = readSmallJson(path.join(directory, "receipt.json"));
    if (data?.schema !== "kmj-browser-fast-v1" || data.target !== "kmj_public" ||
      !["moli_semantic", "chrome_fidelity_fallback"].includes(data.mode) ||
      !Array.isArray(data.samples) || data.samples.length > 3)
      throw Error("INVALID_SCHEMA");

    let samples = [];
    if (data.verdict === "EXTRACTION_PASS") {
      if (data.mode !== "moli_semantic" || data.samples.length !== 3) throw Error("EXTRACTION_INCOMPLETE");
      const byPath = new Map();
      for (const s of data.samples) {
        if (!PATHS.includes(s.path) || byPath.has(s.path) || s.httpStatus !== 200 ||
          !Number.isInteger(s.htmlBytes) || s.htmlBytes < 40 || s.htmlBytes > 1024 * 1024 ||
          !VALID_SHA.test(s.sha256) || !Number.isInteger(s.elapsedMs) ||
          s.elapsedMs < 0 || s.elapsedMs > 14500) throw Error("EXTRACTION_INVALID");
        byPath.set(s.path, s);
      }
      if (PATHS.some((p) => !byPath.has(p))) throw Error("EXTRACTION_MISSING");
      samples = PATHS.map((p) => {
        const s = byPath.get(p);
        return { path: p, httpStatus: s.httpStatus, htmlBytes: s.htmlBytes, sha256: s.sha256, elapsedMs: s.elapsedMs };
      });
    } else if (data.verdict === "CHROME_QA_PASS") {
      if (data.mode !== "chrome_fidelity_fallback" || data.chromeVerdict !== "PASS" ||
        data.chromeSamples !== 9) throw Error("FALLBACK_INVALID");
      const chrome = path.join(directory, "chrome");
      const dst = fs.lstatSync(chrome);
      if (!dst.isDirectory() || dst.isSymbolicLink()) throw Error("FALLBACK_DIRECTORY_INVALID");
      const proof = readSmallJson(path.join(chrome, "receipt.json"));
      if (proof.schema !== "kmj-browser-v1" || proof.target !== "kmj_public" ||
        proof.verdict !== "PASS" || !Array.isArray(proof.samples) || proof.samples.length !== 9)
        throw Error("FALLBACK_PROOF_INVALID");
      const seen = new Set();
      for (const s of proof.samples) {
        if (!VIEWS.includes(s.viewport) || !PATHS.includes(s.path) ||
          !Array.isArray(s.failures) || s.failures.length !== 0)
          throw Error("FALLBACK_SAMPLE_INVALID");
        const name = s.viewport + "-" + (s.path === "/" ? "home" : s.path.slice(1)) + ".png";
        if (s.screenshot !== name || seen.has(name) || !VALID_SHA.test(s.sha256) ||
          !Number.isInteger(s.bytes) || s.bytes < 64 || s.bytes > 8 * 1024 * 1024)
          throw Error("FALLBACK_SAMPLE_INVALID");
        seen.add(name);
        const file = path.join(chrome, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== s.bytes)
          throw Error("FALLBACK_FILE_INVALID");
        if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== s.sha256)
          throw Error("FALLBACK_HASH_MISMATCH");
        samples.push({ path: s.path, viewport: s.viewport, screenshotSha256: s.sha256, screenshotBytes: s.bytes });
      }
      if (seen.size !== 9) throw Error("FALLBACK_SAMPLES_INCOMPLETE");
    } else if (data.verdict === "FAIL" && data.samples.length <= 3) {
      return { verified: true, verdict: "FAIL", engine: data.mode, samples: [], reason: "BROWSER_FAST_PROBE_FAILED" };
    } else {
      throw Error("VERDICT_INVALID");
    }

    return { verified: true, verdict: data.verdict, engine: data.mode, samples };
  } catch {
    throw Error("BROWSER_FAST_RECEIPT_INVALID");
  }
}
