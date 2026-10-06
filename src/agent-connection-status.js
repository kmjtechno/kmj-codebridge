import fs from "node:fs";
import path from "node:path";

const ALLOWED = new Set([
  "CONNECTED",
  "GATEWAY_UNAUTHORIZED",
  "GATEWAY_FORBIDDEN",
  "GATEWAY_POLL_CONFLICT",
  "GATEWAY_RATE_LIMITED",
  "GATEWAY_UNAVAILABLE",
  "GATEWAY_REQUEST_REJECTED",
  "NETWORK_ERROR",
]);

export function gatewayFailureCode(status) {
  if (status === 401) return "GATEWAY_UNAUTHORIZED";
  if (status === 403) return "GATEWAY_FORBIDDEN";
  if (status === 409) return "GATEWAY_POLL_CONFLICT";
  if (status === 429) return "GATEWAY_RATE_LIMITED";
  if (Number.isInteger(status) && status >= 500 && status <= 599)
    return "GATEWAY_UNAVAILABLE";
  return "GATEWAY_REQUEST_REJECTED";
}

export class AgentConnectionRecorder {
  constructor(stateDir, { now = () => Date.now() } = {}) {
    this.file = path.join(stateDir, "connection-status.json");
    this.now = now;
    this.lastCode = null;
    this.lastWritten = 0;
  }

  record(code) {
    const safeCode = ALLOWED.has(code) ? code : "NETWORK_ERROR";
    const now = this.now();
    if (
      safeCode === this.lastCode &&
      (safeCode === "CONNECTED" || now - this.lastWritten < 30000)
    )
      return;

    const value = {
      schema: 1,
      status: safeCode === "CONNECTED" ? "connected" : "error",
      errorCode: safeCode === "CONNECTED" ? null : safeCode,
      observedAt: new Date(now).toISOString(),
    };
    const tmp = this.file + ".tmp-" + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(value) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      fs.renameSync(tmp, this.file);
      this.lastCode = safeCode;
      this.lastWritten = now;
    } catch {
      // Connection diagnostics must never interrupt the agent data plane.
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
}
