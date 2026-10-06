import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file));
const json = (file) => JSON.parse(read(file).toString("utf8"));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const canonical = "assets/icon.png";

function pngInfo(data) {
  assert.deepEqual(data.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(data.toString("ascii", 12, 16), "IHDR");
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const colorType = data[25];
  assert.ok(width >= 64 && width <= 4096);
  assert.ok(height >= 64 && height <= 4096);
  assert.ok([2, 3, 6].includes(colorType), "expected RGB, indexed, or RGBA PNG");
  return { width, height, colorType };
}

test("all supported ChatGPT and Claude icon fields select the same existing CodeBridge asset", () => {
  const plugin = json("plugin/plugin.json");
  const ui = plugin.extensions["com.openai"].interface;
  for (const field of ["logo", "logoDark", "composerIcon", "composerIconDark"])
    assert.equal(ui[field], "./" + canonical, field);
  assert.equal(json("claude-plugin/.claude-plugin/plugin.json").icon, "./" + canonical);
  assert.equal(plugin.extensions["com.openai"].apps, "./.app.json");
  assert.equal(
    json("plugin/.app.json").apps.codebridge.id,
    "asdk_app_6abf4c8dddb08191a983c2bd9fe79732",
  );
});

test("canonical icon bytes are identical in both client packages and are valid square PNGs", () => {
  const icon = read("plugin/" + canonical);
  const claude = read("claude-plugin/" + canonical);
  assert.equal(sha256(icon), sha256(claude));
  const info = pngInfo(icon);
  assert.equal(info.width, info.height, "app icon must be square");
  assert.ok(icon.length > 1024 && icon.length < 2 * 1024 * 1024);
});

test("the distinct legacy logo is not selected for ChatGPT or Claude icon surfaces", () => {
  const icon = read("plugin/" + canonical);
  const logo = read("plugin/assets/logo.png");
  pngInfo(logo);
  assert.notEqual(sha256(icon), sha256(logo));
  assert.equal(sha256(logo), sha256(read("claude-plugin/assets/logo.png")));
});
