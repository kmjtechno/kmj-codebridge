// Fixed-origin public browser QA. No arbitrary URL, credential, script injection
// or browser debugging port. Local screenshot hashes and receipts only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  chromeCandidates,
  selectInstalledBinary,
} from "../src/browser-runtime.js";
export { chromeCandidates } from "../src/browser-runtime.js";

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
export function assess(sample) {
  const failures = [];
  if (sample.actualUrl !== sample.expectedUrl)
    failures.push("UNEXPECTED_NAVIGATION");
  if (sample.httpStatus !== 200) failures.push("HTTP_NOT_200");
  if (sample.bodyLength < 40) failures.push("BLANK_PAGE");
  // Distinguish a timed-out load from a resource that completed with no pixels.
  // Both remain hard QA failures; never call an unresolved image healthy.
  // Legacy receipts without separate counters still fail closed.
  if (sample.failedImages > 0) failures.push("BROKEN_IMAGES");
  if (sample.pendingImages > 0) failures.push("PENDING_IMAGES_TIMEOUT");
  if (sample.brokenImages && !(sample.failedImages > 0 || sample.pendingImages > 0))
    failures.push("BROKEN_IMAGES");
  if (sample.exceptions) failures.push("JS_EXCEPTIONS");
  if (sample.overflowPx > 2) failures.push("HORIZONTAL_OVERFLOW");
  return failures;
}
const digest = (buf) => createHash("sha256").update(buf).digest("hex");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A load event can precede client hydration. Permit a tightly bounded retry
// only when text is initially blank; persistent blanks remain QA failures.
export async function measureAfterTextReady(
  measure,
  {
    minimumChars = 40,
    timeoutMs = 3500,
    pollMs = 175,
    clock = Date.now,
    sleep = wait,
  } = {},
) {
  const deadline = clock() + timeoutMs;
  let sample = await measure();
  while (sample.bodyLength < minimumChars && clock() < deadline) {
    await sleep(Math.max(0, Math.min(pollMs, deadline - clock())));
    sample = await measure();
  }
  return sample;
}

// A mobile viewport can expose many offscreen lazy images at once. Allow a
// bounded second window ONLY for images still pending, not for failed (404/
// undecodable) images. Timed-out pending images remain explicit QA failures.
export async function measureAfterImagesReady(
  measure,
  {
    initial,
    timeoutMs = 3000,
    pollMs = 200,
    clock = Date.now,
    sleep = wait,
  } = {},
) {
  const deadline = clock() + timeoutMs;
  let sample = initial ?? (await measure());
  // Once a hard image failure is known, a pending-image retry cannot fix it.
  while (sample.pendingImages > 0 && !(sample.failedImages > 0) && clock() < deadline) {
    await sleep(Math.max(0, Math.min(pollMs, deadline - clock())));
    sample = await measure();
  }
  return sample;
}

// Chrome started by a hardened systemd agent cannot rely on a writable
// service HOME. Keep Chrome/XDG state inside its per-run private tmp tree.
// No global process.env changes, root-mode launch or sandbox opt-out.
export function createChromePrivateEnvironment(
  root,
  baseEnv = process.env,
  platform = process.platform,
) {
  const home = path.join(root, "home");
  const config = path.join(root, "config");
  const cache = path.join(root, "cache");
  const temporary = path.join(root, "tmp");
  for (const directory of [home, config, cache, temporary])
    fs.mkdirSync(directory, { mode: 0o700 });
  // Do not pass CodeBridge device credentials, cloud API keys, proxy auth or
  // arbitrary parent process variables into untrusted browser child processes.
  const safe = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "TZ",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
  ])
    if (typeof baseEnv[key] === "string") safe[key] = baseEnv[key];
  if (platform === "win32")
    return {
      ...safe,
      USERPROFILE: home,
      LOCALAPPDATA: config,
      APPDATA: config,
      TEMP: temporary,
      TMP: temporary,
    };
  return {
    ...safe,
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    TMPDIR: temporary,
  };
}
export async function publicBrowserQa(targetName, outputDir) {
  const target = allowedTarget(targetName);
  if (!path.isAbsolute(outputDir) || outputDir.includes("\0"))
    throw Error("BROWSER_OUTPUT_INVALID");
  if (process.platform !== "win32" && process.getuid?.() === 0)
    throw Error("BROWSER_ROOT_UNSAFE");
  const browserBinary = selectInstalledBinary(chromeCandidates());
  if (!browserBinary) throw Error("BROWSER_BINARY_NOT_INSTALLED");
  if (fs.existsSync(outputDir)) throw Error("BROWSER_RECEIPT_COLLISION");
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  const profileRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "kmj-public-chrome-"),
  );
  const profile = path.join(profileRoot, "profile");
  const chromeEnv = createChromePrivateEnvironment(profileRoot);
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
      env: chromeEnv,
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
        // Native lazy loading defers offscreen images beyond Page.loadEventFired.
        // Request them in this ephemeral browser and wait briefly for load/error
        // so a healthy lazy image does not produce a false failure.
        const settled = await send(
          "Runtime.evaluate",
          {
            awaitPromise: true,
            returnByValue: true,
            expression:
              "(async()=>{const images=[...document.images];for(const image of images)if(image.loading==='lazy')image.loading='eager';await Promise.race([Promise.all(images.map(image=>image.complete?Promise.resolve():new Promise(resolve=>{image.addEventListener('load',resolve,{once:true});image.addEventListener('error',resolve,{once:true})}))),new Promise(resolve=>setTimeout(resolve,4000))]);await document.fonts.ready;return true})()",
          },
          sessionId,
        );
        if (settled.exceptionDetails || settled.result?.value !== true)
          throw Error("BROWSER_MEASUREMENT_FAILED");
        const measurePage = async () => {
          const result = await send(
            "Runtime.evaluate",
            {
              returnByValue: true,
              expression:
                "(() => ({actualUrl:location.href,bodyLength:(document.body?.innerText||'').length,overflowPx:Math.max(0,document.documentElement.scrollWidth-innerWidth),brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).length,pendingImages:[...document.images].filter(i=>!i.complete).length,failedImages:[...document.images].filter(i=>i.complete&&!i.naturalWidth).length}))()",
            },
            sessionId,
          );
          if (result.exceptionDetails || !result.result?.value)
            throw Error("BROWSER_MEASUREMENT_FAILED");
          return result.result.value;
        };
        const initialMetrics = await measureAfterTextReady(measurePage);
        const metrics = await measureAfterImagesReady(measurePage, {
          initial: initialMetrics,
        });
        const sample = {
          viewport: vp.name,
          path: pagePath,
          expectedUrl,
          ...metrics,
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
          pendingImages: sample.pendingImages,
          failedImages: sample.failedImages,
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
      fs.rmSync(profileRoot, { recursive: true, force: true });
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
