import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { startHostedGateway } from "../src/hosted.js";
import { APPROVED_ICON_URL } from "../src/branded-status.js";
import { definitions } from "../src/tools.js";

const { publicKey } = generateKeyPairSync("ed25519");
const baseConfig = {
  allowedHosts: ["bridge.example"],
  oauth: {
    issuer: "https://identity.example",
    resource: "https://bridge.example/mcp",
    jwks: { keys: [publicKey.export({ format: "jwk" })] },
  },
  users: [
    {
      id: "u1",
      subject: "user1",
      tenant: "t1",
      devices: { d1: ["p1"] },
      permissions: ["read", "write"],
    },
  ],
  agents: [{ id: "d1", tenant: "t1", tokenHash: "a".repeat(64) }],
};

function request(url, method, params = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 15,
      method,
      params,
    });
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          host: "bridge.example",
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const raw = Buffer.concat(chunks).toString("utf8");
            const dataLine = raw.split(/\r?\n/).find((line) => line.startsWith("data:"));
            const reply = JSON.parse(dataLine ? dataLine.slice(5) : raw);
            resolve({ status: res.statusCode, body: reply });
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

async function verifyCatalog(iconUrl) {
  const config =
    iconUrl === undefined
      ? baseConfig
      : { ...baseConfig, iconUrl };
  const gateway = await startHostedGateway(JSON.stringify(config), "0");
  const url = gateway.url.replace("0.0.0.0", "127.0.0.1") + "/mcp";
  try {
    const initialize = await request(url, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "icon-test", version: "1.0.0" },
    });
    assert.equal(initialize.status, 200);
    const catalog = await request(url, "tools/list");
    assert.equal(catalog.status, 200);
    return {
      serverInfo: initialize.body.result.serverInfo,
      tools: catalog.body.result.tools,
    };
  } finally {
    await gateway.close();
  }
}

test("locked KMJ icon is present on initialize AND read/write tool catalog by default", async () => {
  const { serverInfo, tools } = await verifyCatalog();
  assert.match(APPROVED_ICON_URL, /^https:\/\/raw\.githubusercontent\.com\//);
  assert.deepEqual(serverInfo.icons, [{ src: APPROVED_ICON_URL, mimeType: "image/png" }]);
  for (const name of ["read_file", "write_file", "write_files_atomic", "render_codebridge_status"]) {
    const tool = tools.find((item) => item.name === name);
    assert.ok(tool, "missing " + name);
    assert.deepEqual(tool.icons, serverInfo.icons);
  }
  assert.equal(tools.find((x) => x.name === "read_file").annotations.readOnlyHint, true);
  assert.equal(tools.find((x) => x.name === "write_files_atomic").annotations.readOnlyHint, false);
  assert.equal(tools.find((x) => x.name === "write_files_atomic").annotations.destructiveHint, true);
});

test("operator validated custom HTTPS icon continues to override the locked default", async () => {
  const custom = "https://brand.example/approved-icon.png";
  const { serverInfo, tools } = await verifyCatalog(custom);
  assert.deepEqual(serverInfo.icons, [{ src: custom, mimeType: "image/png" }]);
  assert.deepEqual(tools.find((x) => x.name === "write_file").icons, serverInfo.icons);
});

test("one atomic multi-file write remains a write tool and accepts up to 50 guarded changes", () => {
  const single = definitions.write_file;
  const batch = definitions.write_files_atomic;
  const preview = definitions.preview_file;
  assert.equal(preview.access, "read");
  assert.equal(single.access, "write");
  assert.equal(batch.access, "write");
  assert.match(batch.title, /guarded multi-file batch/);
  assert.match(batch.description, /host approval/i);
  assert.match(single.description, /write_files_atomic/);
  const change = { path: "README.md", content: "Safe edit", expectedHash: "a".repeat(64) };
  assert.equal(batch.input.changes.safeParse([change]).success, true);
  assert.equal(batch.input.changes.safeParse(Array(51).fill(change)).success, false);
});
