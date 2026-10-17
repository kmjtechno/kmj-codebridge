// Fixed-origin public browser QA. No arbitrary URL, credential, script injection
// or browser debugging port. Local screenshot hashes and receipts only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export const TARGETS = Object.freeze({
  kmj_public: Object.freeze({
    origin: "https://kmjtechno.com",
    paths: Object.freeze(["/", "/products", "/login"]),
  }),
});
export const VIEWPORTS = Object.freeze([
  { name: "desktop", width: 1440, height: 900, mobile: false },
  { name: "tablet", width: 768, height: 1024, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
]);
export function allowedTarget(name) {
  if (!Object.hasOwn(TARGETS, name)) throw Error("BROWSER_TARGET_NOT_ALLOWED");
  return TARGETS[name];
}
export function chromeCandidates(platform = process.platform) {
  return platform === "win32"
    ? [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      ]
    : [
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
      ];
}
export function assess(sample) {
  const failures = [];
  if (sample.actualUrl !== sample.expectedUrl)
    failures.push("UNEXPECTED_NAVIGATION");
  if (sample.httpStatus !== 200) failures.push("HTTP_NOT_200");
  if (sample.bodyLength < 40) failures.push("BLANK_PAGE");
  if (sample.brokenImages) failures.push("BROKEN_IMAGES");
  if (sample.exceptions) failures.push("JS_EXCEPTIONS");
  if (sample.overflowPx > 2) failures.push("HORIZONTAL_OVERFLOW");
  return failures;
}
const digest = (buf) => createHash("sha256").update(buf).digest("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function publicBrowserQa(targetName, outputDir) {
  const target = allowedTarget(targetName);
  if (!path.isAbsolute(outputDir) || outputDir.includes("\0"))
    throw Error("BROWSER_OUTPUT_INVALID");
  if (process.platform !== "win32" && process.getuid?.() === 0)
    throw Error("BROWSER_ROOT_UNSAFE");
  const browserBinary = chromeCandidates().find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
  if (!browserBinary) throw Error("BROWSER_BINARY_NOT_INSTALLED");
  if (fs.existsSync(outputDir)) throw Error("BROWSER_RECEIPT_COLLISION");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kmj-public-chrome-"));
  const browser = spawn(
    browserBinary,
    [
      "--headless=new",
      "--disable-extensions",
      "--disable-sync",
      "--disable-background-networking",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-pipe",
      "--user-data-dir=" + profile,
      "about:blank",
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    },
  );
  const processExited = new Promise((resolve) =>
    browser.once("close", resolve),
  );
  const pending = new Map();
  const sessions = new Map();
  let counter = 0;
  let buffer = "";
  let closed = false;
  const failPending = () => {
    closed = true;
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error("BROWSER_DISCONNECTED"));
    }
    pending.clear();
  };
  browser.on("error", failPending);
  browser.on("close", failPending);
  browser.stdio[3].on("error", failPending);
  browser.stdio[4].on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 16 * 1024 * 1024) {
      failPending();
      browser.kill();
      return;
    }
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!raw) continue;
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        failPending();
        return;
      }
      const entry = pending.get(message.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(message.id);
        message.error
          ? entry.reject(Error("BROWSER_COMMAND_FAILED"))
          : entry.resolve(message.result);
      }
      const state = sessions.get(message.sessionId);
      if (!state) continue;
      if (message.method === "Runtime.exceptionThrown") state.exceptions++;
      if (
        message.method === "Network.responseReceived" &&
        message.params?.type === "Document" &&
        message.params.response?.url === state.expectedUrl
      )
        state.httpStatus = message.params.response.status;
      if (message.method === "Page.loadEventFired") state.loaded = true;
    }
  });
  const send = (method, params = {}, sessionId) => {
    if (closed) return Promise.reject(Error("BROWSER_DISCONNECTED"));
    return new Promise((resolve, reject) => {
      const id = ++counter;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error("BROWSER_COMMAND_TIMEOUT"));
      }, 15000);
      pending.set(id, { resolve, reject, timer });
      browser.stdio[3].write(
        JSON.stringify({ id, method, params, sessionId }) + "\0",
      );
    });
  };
  const report = {
    schema: "kmj-browser-v1",
    target: targetName,
    origin: target.origin,
    checkedAt: new Date().toISOString(),
    mode: "anonymous_read_only",
    samples: [],
    verdict: "FAIL",
  };
  const deadline = setTimeout(() => {
    failPending();
    browser.kill("SIGKILL");
  }, 115000);
  try {
    await send("Browser.getVersion");
    for (const vp of VIEWPORTS)
      for (const pagePath of target.paths) {
        const expectedUrl = target.origin + pagePath;
        const { targetId } = await send("Target.createTarget", {
          url: "about:blank",
        });
        const { sessionId } = await send("Target.attachToTarget", {
          targetId,
          flatten: true,
        });
        const state = {
          expectedUrl,
          loaded: false,
          httpStatus: null,
          exceptions: 0,
        };
        sessions.set(sessionId, state);
        await send("Page.enable", {}, sessionId);
        await send("Runtime.enable", {}, sessionId);
        await send("Network.enable", {}, sessionId);
        await send(
          "Emulation.setDeviceMetricsOverride",
          {
            width: vp.width,
            height: vp.height,
            deviceScaleFactor: 1,
            mobile: vp.mobile,
          },
          sessionId,
        );
        const nav = await send(
          "Page.navigate",
          { url: expectedUrl },
          sessionId,
        );
        if (nav.errorText) throw Error("BROWSER_NAVIGATION_FAILED");
        const started = Date.now();
        while (!state.loaded && Date.now() - started < 14000) await wait(100);
        if (!state.loaded) throw Error("BROWSER_PAGE_TIMEOUT");
        const result = await send(
          "Runtime.evaluate",
          {
            returnByValue: true,
            expression:
              "(() => ({actualUrl:location.href,bodyLength:(document.body?.innerText||'').length,overflowPx:Math.max(0,document.documentElement.scrollWidth-innerWidth),brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).length}))()",
          },
          sessionId,
        );
        if (result.exceptionDetails || !result.result?.value)
          throw Error("BROWSER_MEASUREMENT_FAILED");
        const sample = {
          viewport: vp.name,
          path: pagePath,
          expectedUrl,
          ...result.result.value,
          httpStatus: state.httpStatus,
          exceptions: state.exceptions,
        };
        const failures = assess(sample);
        const snap = await send(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: false,
          },
          sessionId,
        );
        const bytes = Buffer.from(snap.data, "base64");
        if (bytes.length < 64 || bytes.length > 8 * 1024 * 1024)
          throw Error("BROWSER_SCREENSHOT_INVALID");
        const filename =
          vp.name +
          "-" +
          (pagePath === "/" ? "home" : pagePath.slice(1)) +
          ".png";
        fs.writeFileSync(path.join(outputDir, filename), bytes, {
          flag: "wx",
          mode: 0o600,
        });
        report.samples.push({
          viewport: vp.name,
          path: pagePath,
          httpStatus: state.httpStatus,
          bodyLength: sample.bodyLength,
          overflowPx: sample.overflowPx,
          brokenImages: sample.brokenImages,
          exceptions: sample.exceptions,
          failures,
          screenshot: filename,
          sha256: digest(bytes),
          bytes: bytes.length,
        });
        sessions.delete(sessionId);
        await send("Target.closeTarget", { targetId });
      }
    report.verdict = report.samples.every((v) => v.failures.length === 0)
      ? "PASS"
      : "FAIL";
  } catch (error) {
    report.reason = /^BROWSER_[A-Z_]+$/.test(error?.message ?? "")
      ? error.message
      : "BROWSER_QA_FAILED";
  } finally {
    clearTimeout(deadline);
    try {
      browser.kill();
    } catch {}
    // Windows holds user-data files briefly after SIGTERM. Always persist
    // the browser receipt even if temporary profile cleanup is delayed.
    await Promise.race([processExited, wait(1200)]);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
    fs.writeFileSync(
      path.join(outputDir, "receipt.json"),
      JSON.stringify(report, null, 2),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
  }
  return report;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 4) throw Error("BROWSER_ARGUMENTS_INVALID");
    const report = await publicBrowserQa(process.argv[2], process.argv[3]);
    console.log(
      JSON.stringify({
        target: report.target,
        verdict: report.verdict,
        samples: report.samples.length,
        reason: report.reason ?? null,
        screenshots: report.samples.map((p) => ({
          path: p.path,
          viewport: p.viewport,
          sha256: p.sha256,
        })),
      }),
    );
    if (report.verdict !== "PASS") process.exitCode = 2;
  } catch (error) {
    console.error(
      /^BROWSER_[A-Z_]+$/.test(error?.message ?? "")
        ? error.message
        : "BROWSER_QA_FAILED",
    );
    process.exitCode = 2;
  }
}
