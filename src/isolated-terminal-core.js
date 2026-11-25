import { randomUUID } from "node:crypto";

const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const MAX_COMMAND_BYTES = 8192;
const MAX_OUTPUT_BYTES = 32768;
const MAX_RUNTIME_MS = 120000;

// Internal backend contract. invokeDocker must be provided by the trusted
// local agent, with a pinned local Docker executable and daemon endpoint.
// Never accept that function, Docker flags, mounts, or daemon address from MCP.
export function createIsolatedTerminalCore({
  enabled = false,
  imageId,
  invokeDocker,
}) {
  if (enabled !== true) throw new Error("TERMINAL_OWNER_OPT_IN_REQUIRED");
  if (typeof imageId !== "string" || !IMAGE_ID.test(imageId))
    throw new Error("TERMINAL_PINNED_IMAGE_REQUIRED");
  if (typeof invokeDocker !== "function")
    throw new Error("TERMINAL_LOCAL_BACKEND_REQUIRED");

  return Object.freeze({
    async execute(command, { signal } = {}) {
      if (signal !== undefined && !(signal instanceof AbortSignal))
        throw new Error("TERMINAL_INVALID_CANCELLATION_SIGNAL");
      if (signal?.aborted) throw new Error("TERMINAL_EXECUTION_CANCELLED");
      if (
        typeof command !== "string" ||
        !command.trim() ||
        command.includes("\0") ||
        Buffer.byteLength(command, "utf8") > MAX_COMMAND_BYTES
      )
        throw new Error("TERMINAL_INVALID_COMMAND");

      const name = "kmj-terminal-" + randomUUID();
      // No host bind mount or Docker socket. A later reviewed export/import
      // layer can supply project data without exposing the host checkout.
      const args = [
        "create",
        "--name",
        name,
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
        imageId,
        "-c",
        command,
      ];
      // The shell text is the final *container* argv. The local backend
      // must use shell:false and a bounded, sanitized process environment.
      const created = await invokeDocker(args, {
        timeoutMs: 15000,
        maxOutputBytes: MAX_OUTPUT_BYTES,
      });
      const id =
        typeof created?.stdout === "string" ? created.stdout.trim() : "";
      if (created?.exitCode !== 0 || !CONTAINER_ID.test(id))
        throw new Error("TERMINAL_CONTAINER_CREATION_UNVERIFIED");

      let result;
      let failed = false;
      try {
        if (!signal?.aborted) {
          result = await invokeDocker(["start", "--attach", id], {
            timeoutMs: MAX_RUNTIME_MS,
            maxOutputBytes: MAX_OUTPUT_BYTES,
            ...(signal ? { signal } : {}),
          });
        }
      } catch {
        failed = true;
      } finally {
        // Remove only the exact container created by this invocation.
        // A timeout in the Docker client does not prove the container stopped.
        try {
          const cleanup = await invokeDocker(["rm", "--force", id], {
            timeoutMs: 15000,
            maxOutputBytes: 4096,
          });
          if (cleanup?.exitCode !== 0)
            throw new Error("TERMINAL_CLEANUP_UNVERIFIED");
        } catch {
          throw new Error("TERMINAL_CLEANUP_UNVERIFIED");
        }
      }
      // Cancellation is reported only after exact-ID cleanup succeeded.
      if (signal?.aborted) throw new Error("TERMINAL_EXECUTION_CANCELLED");
      if (failed || !Number.isInteger(result?.exitCode))
        throw new Error("TERMINAL_EXECUTION_UNVERIFIED");
      // Only fixed status metadata crosses this core. The existing JobRunner
      // redaction and receipt layer must handle bounded stdout/stderr later.
      return {
        exitCode: result.exitCode,
        executionSucceeded: result.exitCode === 0,
        containerCleanupVerified: true,
        projectWorkspaceMounted: false,
        hostShellUsed: false,
        productionMutationAuthorized: false,
      };
    },
  });
}
