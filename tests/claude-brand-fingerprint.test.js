import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  APPROVED_CLAUDE_ICON_SHA256,
  classifyFavicon,
  diagnoseClaudeBrand,
  verifyClaudeIcon,
} from "../scripts/diagnose-claude-brand.mjs";

const sampleIco = Buffer.from("000001000100", "hex");

test("Claude source icon is byte-for-byte the approved locked PNG", async () => {
  const original = await readFile(
    new URL("../claude-plugin/assets/icon.png", import.meta.url),
  );
  assert.deepEqual(verifyClaudeIcon(original), {
    status: "LOCKED_ICON_PASS",
    sha256: APPROVED_CLAUDE_ICON_SHA256,
    expectedSha256: APPROVED_CLAUDE_ICON_SHA256,
  });
  assert.equal(
    verifyClaudeIcon(Buffer.from("fake")).status,
    "LOCKED_ICON_MISMATCH",
  );
});

test("known Laravel icon is detected; unfamiliar icon never becomes a visual PASS", () => {
  const stock = classifyFavicon(
    sampleIco,
    "image/x-icon",
    "08242d646ff63d0fa7f43b1f34868700",
  );
  assert.equal(stock.status, "LARAVEL_DEFAULT_DETECTED");
  const unknown = classifyFavicon(sampleIco, "image/x-icon");
  assert.equal(unknown.status, "NON_STOCK_ICO_VISUAL_UNVERIFIED");
  assert.equal(unknown.claudeVisibleIconVerified, false);
});

test("public favicon probe is fixed-origin, GET-only, secret-free and no redirect", async () => {
  const calls = [];
  const report = await diagnoseClaudeBrand({
    readIcon: async () => Buffer.from("fake"),
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response(sampleIco, {
        status: 200,
        headers: { "content-type": "image/x-icon" },
      });
    },
  });
  assert.equal(report.sourceIcon.status, "LOCKED_ICON_MISMATCH");
  assert.equal(report.favicon.status, "NON_STOCK_ICO_VISUAL_UNVERIFIED");
  assert.equal(report.oauthConnectionVerified, false);
  assert.equal(report.claudeVisibleIconVerified, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://kmjtechno.com/favicon.ico");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.body, undefined);
});

test("unavailable or redirected favicon fails closed", async () => {
  const report = await diagnoseClaudeBrand({
    readIcon: async () => Buffer.from("fake"),
    fetcher: async () => new Response(null, { status: 302 }),
  });
  assert.equal(report.favicon.status, "LIVE_FAVICON_UNVERIFIED");
  assert.equal(report.favicon.reason, "HTTP_302");
});

test("oversized favicon fails closed without a visual PASS", async () => {
  const report = await diagnoseClaudeBrand({
    readIcon: async () => Buffer.from("fake"),
    fetcher: async () =>
      new Response(Buffer.alloc(262_145), {
        headers: { "content-type": "image/x-icon" },
      }),
  });
  assert.equal(report.favicon.status, "LIVE_FAVICON_UNVERIFIED");
  assert.equal(report.favicon.reason, "FAVICON_TOO_LARGE");
  assert.equal(report.claudeVisibleIconVerified, false);
});
