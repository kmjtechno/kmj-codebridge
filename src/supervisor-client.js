import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { createHmac } from "node:crypto";
import { CodeBridgeError, fail } from "./errors.js";

export const SUPERVISOR_SOCKET = "/run/kmj-codebridge/supervisor.sock";
const MAX_RESPONSE_BYTES = 65536;

export async function supervisorRequest(
  socketPath,
  request,
  { timeoutMs = 3000 } = {},
) {
  if (
    process.platform === "win32" ||
    socketPath !== SUPERVISOR_SOCKET ||
    !path.isAbsolute(socketPath)
  )
    fail("SUPERVISOR_UNAVAILABLE");

  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let received = Buffer.alloc(0);
    const timer = setTimeout(
      () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new CodeBridgeError("SUPERVISOR_TIMEOUT"));
      },
      Math.max(100, Math.min(timeoutMs, 10000)),
    );

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_RESPONSE_BYTES) {
        done(reject, new CodeBridgeError("SUPERVISOR_RESPONSE_TOO_LARGE"));
        return;
      }
      const newline = received.indexOf(10);
      if (newline < 0) return;
      try {
        const body = JSON.parse(received.subarray(0, newline).toString("utf8"));
        if (!body?.ok) {
          const code =
            typeof body?.error === "string" &&
            /^SUPERVISOR_[A-Z_]+$/.test(body.error)
              ? body.error
              : "SUPERVISOR_REQUEST_FAILED";
          done(reject, new CodeBridgeError(code));
          return;
        }
        done(resolve, body.result);
      } catch {
        done(reject, new CodeBridgeError("SUPERVISOR_INVALID_RESPONSE"));
      }
    });
    socket.on("error", () => {
      done(reject, new CodeBridgeError("SUPERVISOR_UNAVAILABLE"));
    });
  });
}

const WINDOWS_PIPE =
  /^\\\\\.\\pipe\\kmj-codebridge-supervisor-[a-z0-9-]{1,40}$/;

// Windows transport: named pipe + HMAC challenge-response. The secret is read
// from an operator-owned, ACL-restricted file on every call (never cached in
// config, logs or errors). The Linux socket path above stays win32-refusing.
export async function windowsSupervisorRequest(
  { pipePath, tokenFile },
  request,
  { timeoutMs = 3000, platform = process.platform } = {},
) {
  if (platform !== "win32" || !WINDOWS_PIPE.test(String(pipePath)))
    fail("SUPERVISOR_UNAVAILABLE");
  let token;
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    fail("SUPERVISOR_UNAVAILABLE");
  }
  if (Buffer.byteLength(token) < 32) fail("SUPERVISOR_UNAVAILABLE");
  return await challengeResponseRequest({
    socketPath: pipePath,
    token,
    request,
    timeoutMs,
  });
}

// Shared handshake, exported so the protocol can be tested over a plain socket.
export async function challengeResponseRequest({
  socketPath,
  token,
  request,
  timeoutMs = 3000,
}) {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let settled = false;
    let received = Buffer.alloc(0);
    let sent = false;
    const timer = setTimeout(
      () => done(reject, new CodeBridgeError("SUPERVISOR_TIMEOUT")),
      Math.max(100, Math.min(timeoutMs, 10000)),
    );
    function done(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    }
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_RESPONSE_BYTES) {
        done(reject, new CodeBridgeError("SUPERVISOR_RESPONSE_TOO_LARGE"));
        return;
      }
      const newline = received.indexOf(10);
      if (newline < 0) return;
      let body;
      try {
        body = JSON.parse(received.subarray(0, newline).toString("utf8"));
      } catch {
        done(reject, new CodeBridgeError("SUPERVISOR_INVALID_RESPONSE"));
        return;
      }
      if (!sent) {
        if (
          typeof body?.nonce !== "string" ||
          !/^[a-f0-9]{32}$/.test(body.nonce)
        ) {
          done(reject, new CodeBridgeError("SUPERVISOR_INVALID_RESPONSE"));
          return;
        }
        sent = true;
        received = received.subarray(newline + 1);
        const requestJson = JSON.stringify(request);
        const mac = createHmac("sha256", token)
          .update(`${body.nonce}\n${requestJson}`)
          .digest("hex");
        socket.write(JSON.stringify({ request, mac }) + "\n");
        return;
      }
      if (!body?.ok) {
        const code =
          typeof body?.error === "string" &&
          /^SUPERVISOR_[A-Z_]+$/.test(body.error)
            ? body.error
            : "SUPERVISOR_REQUEST_FAILED";
        done(reject, new CodeBridgeError(code));
        return;
      }
      done(resolve, body.result);
    });
    socket.on("error", () =>
      done(reject, new CodeBridgeError("SUPERVISOR_UNAVAILABLE")),
    );
  });
}
