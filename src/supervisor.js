import fs from "node:fs";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import { agentSchema, gatewaySchema } from "./config.js";
import { fail, publicError } from "./errors.js";
import { redact } from "./jobs.js";

const SERVICES = {
  agent: "kmj-codebridge-agent.service",
  gateway: "kmj-codebridge-gateway.service",
};
const CONFIGS = {
  agent: "/etc/kmj-codebridge/agent.json",
  gateway: "/etc/kmj-codebridge/gateway.json",
};
const SYSTEMCTL = "/usr/bin/systemctl";
const JOURNALCTL = "/usr/bin/journalctl";
const MAX_REQUEST_BYTES = 16384;

function exactKeys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("INVALID_SUPERVISOR_REQUEST");
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)))
    fail("INVALID_SUPERVISOR_REQUEST");
}

function serviceUnit(service) {
  const unit = SERVICES[service];
  if (!unit) fail("SUPERVISOR_SERVICE_NOT_ALLOWED");
  return unit;
}

function parseStatus(text) {
  const fields = {};
  for (const line of String(text).trim().split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return {
    activeState: fields.ActiveState ?? "unknown",
    subState: fields.SubState ?? "unknown",
    mainPid: Number(fields.MainPID ?? 0),
    restarts: Number(fields.NRestarts ?? 0),
  };
}

function defaultRun(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 65536,
    windowsHide: true,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
    },
    ...options,
  });
}

function defaultRestart(unit) {
  const child = spawn(SYSTEMCTL, ["restart", unit], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
    },
  });
  child.unref();
}

export function createSupervisorHandler({
  run = defaultRun,
  restart = defaultRestart,
  readFile = (file) => fs.readFileSync(file, "utf8"),
  statfs = (target) => fs.statfsSync(target),
} = {}) {
  return async function handle(request) {
    exactKeys(request, ["op", "service", "lines"]);
    if (typeof request.op !== "string") fail("INVALID_SUPERVISOR_REQUEST");

    if (request.op === "status") {
      exactKeys(request, ["op", "service"]);
      const unit = serviceUnit(request.service);
      const output = run(SYSTEMCTL, [
        "show",
        unit,
        "--property=ActiveState",
        "--property=SubState",
        "--property=MainPID",
        "--property=NRestarts",
        "--no-pager",
      ]);
      return { response: { service: request.service, ...parseStatus(output) } };
    }

    if (request.op === "logs") {
      exactKeys(request, ["op", "service", "lines"]);
      const unit = serviceUnit(request.service);
      const lines = request.lines ?? 80;
      if (!Number.isInteger(lines) || lines < 1 || lines > 200)
        fail("INVALID_SUPERVISOR_REQUEST");
      const output = run(JOURNALCTL, [
        "-u",
        unit,
        "-n",
        String(lines),
        "--no-pager",
        "--output=short-iso",
      ]);
      return {
        response: {
          service: request.service,
          lines,
          output: redact(String(output)).slice(0, 65536),
        },
      };
    }

    if (request.op === "config_validate") {
      exactKeys(request, ["op", "service"]);
      const configPath = CONFIGS[request.service];
      if (!configPath) fail("SUPERVISOR_SERVICE_NOT_ALLOWED");
      try {
        const raw = JSON.parse(readFile(configPath));
        if (request.service === "agent") agentSchema.parse(raw);
        else gatewaySchema.parse(raw);
        return { response: { service: request.service, valid: true } };
      } catch {
        return { response: { service: request.service, valid: false } };
      }
    }

    if (request.op === "restart") {
      exactKeys(request, ["op", "service"]);
      const unit = serviceUnit(request.service);
      return {
        response: { service: request.service, accepted: true },
        afterSend: () => restart(unit),
      };
    }

    if (request.op === "disk_space") {
      exactKeys(request, ["op"]);
      const target = fs.existsSync("/var/lib/kmj-codebridge")
        ? "/var/lib/kmj-codebridge"
        : "/";
      const stats = statfs(target);
      const blockSize = Number(stats.bsize);
      return {
        response: {
          target,
          totalBytes: Number(stats.blocks) * blockSize,
          freeBytes: Number(stats.bavail) * blockSize,
        },
      };
    }

    fail("SUPERVISOR_OPERATION_NOT_ALLOWED");
  };
}

export async function startSupervisor({
  fd = null,
  socketPath = null,
  idleMs = 60000,
  handler = createSupervisorHandler(),
} = {}) {
  if (process.platform === "win32") fail("SUPERVISOR_UNSUPPORTED");
  if (fd === null && !socketPath) fail("SUPERVISOR_LISTENER_REQUIRED");

  let active = 0;
  let idleTimer = null;
  let closing = false;
  const server = net.createServer((socket) => {
    active += 1;
    if (idleTimer) clearTimeout(idleTimer);
    let received = Buffer.alloc(0);

    const finish = () => {
      active = Math.max(0, active - 1);
      if (fd !== null && active === 0 && !closing) {
        idleTimer = setTimeout(() => {
          closing = true;
          server.close();
        }, Math.max(1000, idleMs));
        idleTimer.unref?.();
      }
    };

    socket.on("data", async (chunk) => {
      received = Buffer.concat([received, chunk]);
      if (received.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const newline = received.indexOf(10);
      if (newline < 0) return;
      const raw = received.subarray(0, newline).toString("utf8");
      socket.pause();
      try {
        const request = JSON.parse(raw);
        const { response, afterSend } = await handler(request);
        socket.end(JSON.stringify({ ok: true, result: response }) + "\n", () => {
          if (afterSend) setTimeout(afterSend, 750).unref?.();
        });
      } catch (error) {
        socket.end(
          JSON.stringify({ ok: false, error: publicError(error).error }) + "\n",
        );
      }
    });
    socket.once("close", finish);
    socket.once("error", () => {});
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(fd !== null ? { fd } : { path: socketPath }, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    close: () =>
      new Promise((resolve) => {
        closing = true;
        if (idleTimer) clearTimeout(idleTimer);
        server.close(resolve);
      }),
  };
}
