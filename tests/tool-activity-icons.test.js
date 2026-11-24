import assert from "node:assert/strict";
import test from "node:test";
import { toolActivityIcons } from "../src/tool-activity-icons.js";

const brand = [
  { src: "https://example.test/brand.png", mimeType: "image/png" },
];

test("native tool glyphs are distinct bounded 32x32 PNG data URIs", () => {
  const names = [
    "connection_doctor",
    "git_status",
    "run_quality_gate",
    "read_file",
    "write_file",
    "supervisor_status",
    "autopilot_status",
  ];
  const icons = names.map((name) => toolActivityIcons(name, brand)[0]);
  assert.equal(new Set(icons.map((icon) => icon.src)).size, names.length);
  for (const icon of icons) {
    assert.equal(icon.mimeType, "image/png");
    assert.deepEqual(icon.sizes, ["32x32"]);
    assert.match(icon.src, /^data:image\/png;base64,/);
    const data = Buffer.from(icon.src.split(",")[1], "base64");
    assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(data.readUInt32BE(16), 32);
    assert.equal(data.readUInt32BE(20), 32);
    assert.ok(data.length < 1024);
  }
});

test("unclassified tools and explicit custom branding retain the server icon", () => {
  assert.deepEqual(toolActivityIcons("render_codebridge_status", brand), brand);
  assert.deepEqual(toolActivityIcons("write_file", brand, true), brand);
  assert.deepEqual(toolActivityIcons(null, brand), brand);
});
