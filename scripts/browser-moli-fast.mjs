// Optional KMJ Moli semantic fast lane for a fixed public target.
// Never runs caller-supplied URLs, JS, profiles, commands or authentication.
// Chrome fidelity QA stays the fallback and the existing default tool.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { allowedTarget, publicBrowserQa } from "./browser-public-qa.mjs";

export const MOLI_VERSION = "1.1.18";
export const MOLI_CANDIDATES = Object.freeze(
  process.platform === "win32"
    ? ["C:\\ProgramData\\KMJ\\CodeBridge\\moli\\v1.1.18\\moli.exe"]
    : ["/opt/kmj-codebridge-tools/moli/v1.1.18/bin/moli"],
);

const SHA256 = (v) => createHash("sha256").update(v).digest("hex");
const MAX_STDOUT = 1024 * 1024;
const TIMEOUT_MS = 14000;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{3,79}$/;

export function selectedMoliBinary(candidates = MOLI_CANDIDATES) {
  for (const candidate of candidates) {
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && !stat.isSymbolicLink()) return candidate;
    } catch {}
  }
  return null;
}

// JSON dump is used rather than semantic text so final URL and HTTP status
// are mandatory evidence. Do not expose HTML/cookies/storage into job receipts.
export function parseMoliResult(raw, expectedUrl) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw Error("MOLI_OUTPUT_INVALID");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw Error("MOLI_OUTPUT_INVALID");
  const finalUrl = payload.final_url;
  const status = payload.status;
  const html = payload.html;
  if (typeof finalUrl !== "string" || finalUrl !== expectedUrl)
    throw Error("MOLI_NAVIGATION_UNVERIFIED");
  if (status !== 200) throw Error("MOLI_HTTP_NOT_200");
  if (typeof html !== "string" || html.length < 40)
    throw Error("MOLI_EMPTY_BODY");
  // This is an extraction probe, not visual QA or a complete anti-bot test.
  return {
    httpStatus: status,
    htmlBytes: Buffer.byteLength(html, "utf8"),
    sha256: SHA256(Buffer.from(html, "utf8")),
  };
}

export async function moliFetch(
  expectedUrl,
  { executable = selectedMoliBinary(), spawnFn = spawn } = {},
) {
  if (!executable) throw Error("MOLI_NOT_INSTALLED");
  if (process.platform !== "win32" && process.getuid?.() === 0)
    throw Error("MOLI_ROOT_UNSAFE");
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-moli-fast-"));
  try {
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: work,
      XDG_CONFIG_HOME: work,
      XDG_CACHE_HOME: work,
    };
    return await new Promise((resolve, reject) => {
      // Fetch only allowlisted HTTPS origin; deny RFC1918/localhost redirects.
      const args = [
        "fetch",
        "--block-private-networks",
        "--disable-subframes",
        "--timeout",
        "12000",
        "--dump",
        "json",
        "--wait-selector",
        "body",
        expectedUrl,
      ];
      let child;
      try {
        child = spawnFn(executable, args, {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
          env,
        });
      } catch {
        reject(Error("MOLI_LAUNCH_FAILED"));
        return;
      }
      let buffer = "";
      let done = false;
      const finish = (error, result) => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        if (error) reject(error);
        else resolve(result);
      };
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        finish(Error("MOLI_TIMEOUT"));
      }, TIMEOUT_MS);
      child.stdout.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > MAX_STDOUT) {
          child.kill("SIGKILL");
          finish(Error("MOLI_OUTPUT_TOO_LARGE"));
        }
      });
      child.on("error", () => finish(Error("MOLI_LAUNCH_FAILED")));
      child.on("close", (code) => {
        if (code !== 0) finish(Error("MOLI_COMMAND_FAILED"));
        else {
          try {
            finish(null, parseMoliResult(buffer, expectedUrl));
          } catch (error) {
            finish(error);
          }
        }
      });
    });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

export async function fastBrowserProbe(
  targetName,
  outputDir,
  { moli = moliFetch, chrome = publicBrowserQa } = {},
) {
  const target = allowedTarget(targetName);
  if (
    !path.isAbsolute(outputDir) ||
    outputDir.includes("\0") ||
    fs.existsSync(outputDir)
  )
    throw Error("BROWSER_FAST_OUTPUT_INVALID");
  if (process.platform !== "win32" && process.getuid?.() === 0)
    throw Error("BROWSER_ROOT_UNSAFE");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const receipt = {
    schema: "kmj-browser-fast-v1",
    target: targetName,
    mode: "moli_semantic",
    sourceVersion: MOLI_VERSION,
    checkedAt: new Date().toISOString(),
    samples: [],
    verdict: "FAIL",
  };
  try {
    for (const pagePath of target.paths) {
      const expectedUrl = target.origin + pagePath;
      const started = Date.now();
      const result = await moli(expectedUrl);
      receipt.samples.push({
        path: pagePath,
        httpStatus: result.httpStatus,
        htmlBytes: result.htmlBytes,
        sha256: result.sha256,
        elapsedMs: Date.now() - started,
      });
    }
    receipt.verdict =
      receipt.samples.length === target.paths.length
        ? "EXTRACTION_PASS"
        : "FAIL";
  } catch (error) {
    receipt.fallbackReason = ERROR_CODE.test(error?.message ?? "")
      ? error.message
      : "MOLI_EXTRACT_FAILED";
    receipt.mode = "chrome_fidelity_fallback";
    // Existing QA provides 9 fixed screenshot receipts in private state.
    // Never convert Chrome FAIL to PASS or misrepresent extraction as visual QA.
    try {
      const report = await chrome(targetName, path.join(outputDir, "chrome"));
      receipt.chromeVerdict = report.verdict;
      receipt.chromeSamples = report.samples.length;
      receipt.verdict = report.verdict === "PASS" ? "CHROME_QA_PASS" : "FAIL";
      if (report.reason) receipt.reason = report.reason;
    } catch (fallbackError) {
      receipt.verdict = "FAIL";
      receipt.reason = ERROR_CODE.test(fallbackError?.message ?? "")
        ? fallbackError.message
        : "CHROME_QA_FAILED";
    }
  } finally {
    fs.writeFileSync(
      path.join(outputDir, "receipt.json"),
      JSON.stringify(receipt, null, 2),
      { flag: "wx", mode: 0o600 },
    );
  }
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 4)
      throw Error("BROWSER_FAST_ARGUMENTS_INVALID");
    const result = await fastBrowserProbe(process.argv[2], process.argv[3]);
    console.log(
      JSON.stringify({
        target: result.target,
        engine: result.mode,
        verdict: result.verdict,
        samples: result.samples.length,
        fallbackReason: result.fallbackReason ?? null,
        reason: result.reason ?? null,
      }),
    );
    if (!["EXTRACTION_PASS", "CHROME_QA_PASS"].includes(result.verdict))
      process.exitCode = 2;
  } catch (error) {
    console.error(
      ERROR_CODE.test(error?.message ?? "")
        ? error.message
        : "BROWSER_FAST_PROBE_FAILED",
    );
    process.exitCode = 2;
  }
}
