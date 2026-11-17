// P520 owner-only ephemeral HMAC/ACL smoke. Never starts a Scheduled Task.
// The pinned Windows Supervisor runs ONLY in this process for read-only probes.
// No live agent.json edit, no agent restart, no persistent listener.
import { createHmac } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const releaseSha = "b652b29beafb9b14e42b0078bfb9571fef5b3271";
const root = "C:\\ProgramData\\KMJ-CodeBridge\\P520";
const expectedRelease = path.win32.join(root, "releases", releaseSha);
const expectedConfig = path.win32.join(root, "supervisor.json");
const expectedToken = path.win32.join(root, "supervisor.token");
const expectedPipe = "kmj-codebridge-supervisor-p520";

function samePath(a, b) {
  return (
    typeof a === "string" &&
    path.win32.normalize(a).toLowerCase() ===
      path.win32.normalize(b).toLowerCase()
  );
}

function fail(code) {
  throw new Error(code);
}

function exchange(pipePath, token, request, authenticated = true) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let buffer = "";
    let state = "nonce";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("PIPE_TIMEOUT")), 7000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    }
    socket.on("error", () => finish(new Error("PIPE_CONNECTION_FAILED")));
    socket.on("close", () => {
      if (!settled) finish(new Error("PIPE_CLOSED"));
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer, "utf8") > 8192) {
        finish(new Error("PIPE_RESPONSE_OVERSIZED"));
        return;
      }
      let split;
      while ((split = buffer.indexOf("\n")) !== -1 && !settled) {
        const line = buffer.slice(0, split);
        buffer = buffer.slice(split + 1);
        try {
          const msg = JSON.parse(line);
          if (state === "nonce") {
            if (!/^[0-9a-f]{32}$/.test(msg.nonce)) {
              fail("PIPE_NONCE_INVALID");
            }
            const payload = JSON.stringify(request);
            const mac = authenticated
              ? createHmac("sha256", token)
                  .update(msg.nonce + "\n" + payload)
                  .digest("hex")
              : "0".repeat(64);
            state = "response";
            socket.write(JSON.stringify({ request, mac }) + "\n");
          } else {
            finish(null, msg);
            return;
          }
        } catch {
          finish(new Error("PIPE_PROTOCOL_INVALID"));
          return;
        }
      }
    });
  });
}

async function main() {
  if (process.platform !== "win32") fail("WINDOWS_ONLY");
  const release = process.argv[2];
  const configFile = process.argv[3];
  if (!samePath(release, expectedRelease) || !samePath(configFile, expectedConfig)) {
    fail("UNEXPECTED_PATHS");
  }
  const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  if (
    config.pipeName !== expectedPipe ||
    !samePath(config.tokenFile, expectedToken) ||
    !samePath(config.agent?.installDir, expectedRelease) ||
    !Array.isArray(config.projects) ||
    config.projects.length !== 0 ||
    !Array.isArray(config.readOnlyProjects) ||
    config.readOnlyProjects.length !== 0 ||
    "restartTask" in (config.agent ?? {})
  ) {
    fail("UNEXPECTED_SUPERVISOR_CAPABILITIES");
  }
  const { runWindowsSupervisorCli } = await import(
    pathToFileURL(path.win32.join(release, "src", "windows-supervisor-cli.js")).href
  );
  // runWindowsSupervisorCli revalidates schema and token ACL before binding.
  // Its server uses the production nonce/HMAC verifier; not a mock listener.
  let server;
  try {
    server = await runWindowsSupervisorCli(configFile);
    const pipe = "\\\\.\\pipe\\" + expectedPipe;
    const token = fs.readFileSync(config.tokenFile, "utf8").trim();
    const invalid = await exchange(
      pipe,
      token,
      { op: "status", service: "agent" },
      false,
    );
    if (invalid.ok !== false || invalid.error !== "SUPERVISOR_UNAUTHENTICATED") {
      fail("NEGATIVE_HMAC_CHECK_FAILED");
    }
    console.log("P520_HMAC_REJECTS_BAD_MAC=PASS");
    const status = await exchange(pipe, token, {
      op: "status",
      service: "agent",
    });
    if (
      status.ok !== true ||
      status.result?.supervisor !== "windows-native" ||
      status.result?.restart?.supported !== false ||
      status.result?.update?.supported !== false ||
      status.result?.activeProcessRuntime?.verified !== false ||
      status.result?.runtimeScope !== "configured-install-dir"
    ) {
      fail("AUTHENTICATED_STATUS_INVALID");
    }
    console.log("P520_HMAC_AUTHENTICATED_STATUS=PASS");
    console.log("P520_NO_RESTART_CAPABILITY=PASS");
    const validation = await exchange(pipe, token, {
      op: "config_validate",
      service: "agent",
    });
    if (validation.ok !== true || validation.result?.valid !== true) {
      fail("ACTIVE_AGENT_CONFIG_VALIDATION_FAILED");
    }
    console.log("P520_HMAC_AUTHENTICATED_CONFIG=PASS");
    console.log("P520_EPHEMERAL_PROBE=PASS");
  } finally {
    if (server) await server.close();
  }
}

try {
  await main();
} catch (error) {
  const reason = String(error?.message ?? "");
  const safe = /^[A-Z][A-Z0-9_]{3,90}$/.test(reason) ? reason : "REVIEW_REQUIRED";
  console.error("P520_EPHEMERAL_PROBE=BLOCKED_" + safe);
  process.exitCode = 2;
}
