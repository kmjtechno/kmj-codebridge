import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const NAME = /^kmj-terminal-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const FLAGS = [
  "--label",
  "com.kmjtechno.codebridge=isolated-terminal",
  "--pull=never",
  "--network=none",
  "--read-only",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--user=65532:65532",
  "--pids-limit=128",
  "--memory=1g",
  "--cpus=2",
  "--init",
  "--tmpfs",
  "/tmp:rw,nosuid,nodev,size=128m,mode=1777",
  "--tmpfs",
  "/workspace:rw,nosuid,nodev,size=256m,uid=65532,gid=65532,mode=0700",
  "--workdir=/workspace",
  "--env=HOME=/tmp",
  "--entrypoint=/bin/sh",
];

// Internal, deny-by-default adapter contract, not an MCP or host shell route.
export function validateDockerInvocation(args, limits) {
  if (
    !Array.isArray(args) ||
    args.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !Number.isSafeInteger(limits?.timeoutMs) ||
    limits.timeoutMs < 1 ||
    limits.timeoutMs > 120000 ||
    !Number.isSafeInteger(limits?.maxOutputBytes) ||
    limits.maxOutputBytes < 1 ||
    limits.maxOutputBytes > 32768
  )
    throw new Error("TERMINAL_DOCKER_INVOCATION_DENIED");

  const [verb, flag, target] = args;
  if (
    verb === "create" &&
    flag === "--name" &&
    NAME.test(target) &&
    args.length === 3 + FLAGS.length + 3 &&
    FLAGS.every((value, i) => args[3 + i] === value) &&
    IMAGE.test(args.at(-3)) &&
    args.at(-2) === "-c" &&
    args.at(-1).trim() &&
    Buffer.byteLength(args.at(-1), "utf8") <= 8192
  )
    return;

  if (
    args.length === 3 &&
    ID.test(target) &&
    ((verb === "start" && flag === "--attach") ||
      (verb === "rm" && flag === "--force"))
  )
    return;

  throw new Error("TERMINAL_DOCKER_INVOCATION_DENIED");
}

async function digestFile(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

export async function createPinnedDockerInvoker({
  enabled = false,
  executable,
  executableSha256,
  endpoint,
} = {}) {
  if (enabled !== true) throw new Error("TERMINAL_OWNER_OPT_IN_REQUIRED");
  const localEndpoint =
    process.platform === "win32"
      ? "npipe:////./pipe/dockerDesktopLinuxEngine"
      : process.platform === "linux"
        ? "unix:///var/run/docker.sock"
        : null;
  if (!localEndpoint || endpoint !== localEndpoint)
    throw new Error("TERMINAL_LOCAL_DAEMON_REQUIRED");
  if (
    typeof executable !== "string" ||
    !isAbsolute(executable) ||
    !ID.test(executableSha256 ?? "")
  )
    throw new Error("TERMINAL_PINNED_EXECUTABLE_REQUIRED");

  const path = await realpath(executable);
  if (
    basename(path).toLowerCase() !==
      (process.platform === "win32" ? "docker.exe" : "docker") ||
    !(await lstat(path)).isFile()
  )
    throw new Error("TERMINAL_PINNED_EXECUTABLE_REQUIRED");

  async function verifyExecutable() {
    if (
      (await realpath(executable)) !== path ||
      !(await lstat(path)).isFile() ||
      (await digestFile(path)) !== executableSha256
    )
      throw new Error("TERMINAL_EXECUTABLE_CHANGED");
  }

  await verifyExecutable();
  const owned = new Set();
  return async function invokeDocker(args, limits) {
    validateDockerInvocation(args, limits);
    const verb = args[0];
    if (verb !== "create" && !owned.has(args[2]))
      throw new Error("TERMINAL_CONTAINER_NOT_OWNED");
    await verifyExecutable();

    // Do not inherit proxy, credential, DOCKER_HOST or Docker context settings.
    const dir = await mkdtemp(join(tmpdir(), "kmj-docker-"));
    const env = { HOME: dir, DOCKER_CONFIG: dir, TMPDIR: dir };
    if (process.platform === "win32") {
      env.SystemRoot = process.env.SystemRoot || "C:\\Windows";
      env.TEMP = dir;
      env.TMP = dir;
    }
    try {
      const result = await new Promise((resolve, reject) => {
        execFile(
          path,
          ["--config", dir, "--host", endpoint, ...args],
          {
            cwd: dir,
            env,
            shell: false,
            windowsHide: true,
            timeout: limits.timeoutMs,
            maxBuffer: limits.maxOutputBytes,
            killSignal: "SIGKILL",
            encoding: "utf8",
          },
          (error, stdout, stderr) => {
            if (error && (error.killed || !Number.isInteger(error.code))) {
              reject(new Error("TERMINAL_DOCKER_PROCESS_UNVERIFIED"));
              return;
            }
            if (
              Buffer.byteLength(stdout, "utf8") +
                Buffer.byteLength(stderr, "utf8") >
              limits.maxOutputBytes
            ) {
              reject(new Error("TERMINAL_DOCKER_OUTPUT_LIMIT"));
              return;
            }
            resolve({
              exitCode: error ? error.code : 0,
              stdout: verb === "create" ? stdout : "",
            });
          },
        );
      });
      const id = result.stdout.trim();
      if (verb === "create" && result.exitCode === 0 && ID.test(id))
        owned.add(id);
      if (verb === "rm" && result.exitCode === 0) owned.delete(args[2]);
      return result;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
