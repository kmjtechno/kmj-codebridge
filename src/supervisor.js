import fs from "node:fs";
import net from "node:net";
import os from "node:os";
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
const UPDATE_SERVICE = "kmj-codebridge-auto-update.service";
const MAIN_PLATFORM_REFRESH_SERVICE =
  "kmj-codebridge-main-platform-refresh.service";
const UPDATE_TIMER = "kmj-codebridge-auto-update.timer";
const UPDATE_CHECK_SERVICE = "kmj-codebridge-stable-update.service";
const UPDATE_ROLLBACK_SERVICE = "kmj-codebridge-stable-rollback.service";
const UPDATE_INSTALL_ROOT = "/opt/kmj-codebridge-stable";
const UPDATE_HISTORY = "/var/lib/kmj-codebridge-update/release-history.json";
const RELEASE_NAME =
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{12}$/;
const SYSTEMCTL = "/usr/bin/systemctl";
const JOURNALCTL = "/usr/bin/journalctl";
const MAX_REQUEST_BYTES = 16384;
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function defaultDeviceStatus() {
  const cpus = os.cpus();
  const [one, five, fifteen] = os.loadavg();
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    cpuCount: cpus.length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    loadAverage: { one, five, fifteen },
    uptimeSeconds: Math.floor(os.uptime()),
    processUptimeSeconds: Math.floor(process.uptime()),
    nodeVersion: process.version,
  };
}

function boundedDeviceStatus(raw) {
  const boundedString = (value, max) =>
    typeof value === "string" ? value.slice(0, max) : "unknown";
  const boundedNumber = (value, max = Number.MAX_SAFE_INTEGER) =>
    Number.isFinite(value) && value >= 0 ? Math.min(value, max) : 0;
  return {
    platform: boundedString(raw?.platform, 32),
    arch: boundedString(raw?.arch, 32),
    hostname: boundedString(raw?.hostname, 253),
    cpuCount: Math.floor(boundedNumber(raw?.cpuCount, 4096)),
    totalMemoryBytes: Math.floor(boundedNumber(raw?.totalMemoryBytes)),
    freeMemoryBytes: Math.floor(boundedNumber(raw?.freeMemoryBytes)),
    loadAverage: {
      one: boundedNumber(raw?.loadAverage?.one, 1000000),
      five: boundedNumber(raw?.loadAverage?.five, 1000000),
      fifteen: boundedNumber(raw?.loadAverage?.fifteen, 1000000),
    },
    uptimeSeconds: Math.floor(boundedNumber(raw?.uptimeSeconds)),
    processUptimeSeconds: Math.floor(boundedNumber(raw?.processUptimeSeconds)),
    nodeVersion: boundedString(raw?.nodeVersion, 64),
  };
}

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

function parseProperties(text) {
  const fields = {};
  for (const line of String(text).trim().split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) fields[line.slice(0, index)] = line.slice(index + 1);
  }
  return fields;
}

function parseStatus(text) {
  const fields = parseProperties(text);
  return {
    activeState: fields.ActiveState ?? "unknown",
    subState: fields.SubState ?? "unknown",
    mainPid: Number(fields.MainPID ?? 0),
    restarts: Number(fields.NRestarts ?? 0),
  };
}

function fixedUnitStatus(run, unit, properties) {
  try {
    const fields = parseProperties(
      run(SYSTEMCTL, [
        "show",
        unit,
        "--property=LoadState",
        ...properties.map((name) => `--property=${name}`),
        "--no-pager",
      ]),
    );
    return {
      installed: fields.LoadState !== "not-found",
      ...Object.fromEntries(
        properties.map((name) => [
          name[0].toLowerCase() + name.slice(1),
          fields[name] ?? "unknown",
        ]),
      ),
    };
  } catch {
    return {
      installed: false,
      ...Object.fromEntries(
        properties.map((name) => [
          name[0].toLowerCase() + name.slice(1),
          "unknown",
        ]),
      ),
    };
  }
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

function defaultStart(unit) {
  const child = spawn(SYSTEMCTL, ["start", unit], {
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
  start = defaultStart,
  restart = defaultRestart,
  readFile = (file) => fs.readFileSync(file, "utf8"),
  readlink = (file) => fs.readlinkSync(file),
  lstat = (file) => fs.lstatSync(file),
  statfs = (target) => fs.statfsSync(target),
  exists = (target) => fs.existsSync(target),
  stat = (target) => fs.statSync(target),
  deviceStatus = defaultDeviceStatus,
} = {}) {
  const readUpdateState = () => {
    const readReleaseLink = (name) => {
      try {
        const link = `${UPDATE_INSTALL_ROOT}/${name}`;
        if (!lstat(link).isSymbolicLink()) return null;
        const target = readlink(link);
        const match = /^releases\/([^/]+)$/.exec(target);
        return match && RELEASE_NAME.test(match[1]) ? match[1] : null;
      } catch {
        return null;
      }
    };
    let releases = [];
    try {
      const raw = JSON.parse(readFile(UPDATE_HISTORY));
      if (Array.isArray(raw))
        releases = raw.slice(-20).map((entry) => ({
          action: ["activate", "rollback"].includes(entry?.action)
            ? entry.action
            : "unknown",
          release:
            typeof entry?.release === "string" &&
            RELEASE_NAME.test(entry.release)
              ? entry.release
              : "unknown",
          previous:
            entry?.previous === null
              ? null
              : typeof entry?.previous === "string" &&
                  RELEASE_NAME.test(entry.previous)
                ? entry.previous
                : null,
          at: typeof entry?.at === "string" ? entry.at.slice(0, 64) : null,
        }));
    } catch {
      releases = [];
    }
    return {
      current: readReleaseLink("current"),
      previous: readReleaseLink("previous"),
      releases,
    };
  };

  return async function handle(request) {
    exactKeys(request, ["op", "service", "lines", "projectId"]);
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

    if (request.op === "device_status") {
      exactKeys(request, ["op"]);
      return { response: boundedDeviceStatus(deviceStatus()) };
    }

    if (request.op === "project_status") {
      exactKeys(request, ["op", "projectId"]);
      if (
        typeof request.projectId !== "string" ||
        !PROJECT_ID.test(request.projectId)
      )
        fail("INVALID_SUPERVISOR_REQUEST");
      let agentConfig;
      try {
        agentConfig = agentSchema.parse(JSON.parse(readFile(CONFIGS.agent)));
      } catch {
        fail("SUPERVISOR_CONFIG_INVALID");
      }
      const managedProject = agentConfig.projects.find(
        (project) => project.id === request.projectId,
      );
      if (!managedProject) fail("SUPERVISOR_PROJECT_NOT_AUTHORIZED");
      const root = managedProject.root;
      const present = exists(root);
      let directory = false;
      let gitCheckout = false;
      if (present) {
        try {
          directory = stat(root).isDirectory();
          gitCheckout = directory && exists(`${root}/.git`);
        } catch {
          directory = false;
          gitCheckout = false;
        }
      }
      return {
        response: {
          projectId: request.projectId,
          present,
          directory,
          gitCheckout,
        },
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

    if (request.op === "update_status") {
      exactKeys(request, ["op"]);
      const timer = fixedUnitStatus(run, UPDATE_TIMER, [
        "ActiveState",
        "SubState",
        "UnitFileState",
      ]);
      const service = fixedUnitStatus(run, UPDATE_SERVICE, [
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainStatus",
      ]);
      return {
        response: {
          available: timer.installed && service.installed,
          timer,
          service,
        },
      };
    }

    if (request.op === "main_platform_refresh_status") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, MAIN_PLATFORM_REFRESH_SERVICE, [
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainStatus",
      ]);
      return {
        response: {
          available: service.installed,
          service,
        },
      };
    }

    if (request.op === "main_platform_refresh") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, MAIN_PLATFORM_REFRESH_SERVICE, [
        "ActiveState",
        "SubState",
      ]);
      if (!service.installed)
        fail("SUPERVISOR_MAIN_PLATFORM_REFRESH_UNAVAILABLE");
      return {
        response: { accepted: true },
        afterSend: () => start(MAIN_PLATFORM_REFRESH_SERVICE),
      };
    }

    if (request.op === "update_check") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, UPDATE_CHECK_SERVICE, [
        "ActiveState",
      ]);
      if (!service.installed) fail("SUPERVISOR_UPDATE_UNAVAILABLE");
      return {
        response: { accepted: true },
        afterSend: () => start(UPDATE_CHECK_SERVICE),
      };
    }

    if (request.op === "release_history") {
      exactKeys(request, ["op"]);
      return { response: readUpdateState() };
    }

    if (request.op === "update_rollback") {
      exactKeys(request, ["op"]);
      const state = readUpdateState();
      if (!state.previous) fail("SUPERVISOR_ROLLBACK_UNAVAILABLE");
      const service = fixedUnitStatus(run, UPDATE_ROLLBACK_SERVICE, [
        "ActiveState",
      ]);
      if (!service.installed) fail("SUPERVISOR_ROLLBACK_UNAVAILABLE");
      return {
        response: { accepted: true, target: "previous" },
        afterSend: () => start(UPDATE_ROLLBACK_SERVICE),
      };
    }

    if (request.op === "update_now") {
      exactKeys(request, ["op"]);
      const service = fixedUnitStatus(run, UPDATE_SERVICE, ["ActiveState"]);
      if (!service.installed) fail("SUPERVISOR_UPDATE_UNAVAILABLE");
      return {
        response: { accepted: true },
        afterSend: () => start(UPDATE_SERVICE),
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
        idleTimer = setTimeout(
          () => {
            closing = true;
            server.close();
          },
          Math.max(1000, idleMs),
        );
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
        socket.end(
          JSON.stringify({ ok: true, result: response }) + "\n",
          () => {
            if (afterSend) setTimeout(afterSend, 750).unref?.();
          },
        );
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
