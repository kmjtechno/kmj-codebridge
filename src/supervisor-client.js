import net from "node:net";
import path from "node:path";
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
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new CodeBridgeError("SUPERVISOR_TIMEOUT"));
    }, Math.max(100, Math.min(timeoutMs, 10000)));

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
        done(
          reject,
          new CodeBridgeError("SUPERVISOR_INVALID_RESPONSE"),
        );
      }
    });
    socket.on("error", () => {
      done(
        reject,
        new CodeBridgeError("SUPERVISOR_UNAVAILABLE"),
      );
    });
  });
}
