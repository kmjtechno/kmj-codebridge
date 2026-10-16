import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";

const PINNED_RELEASE_SHA = "e3587be842dcc701236b54a2e1de90238a5c3429";
const PIPE_PREFIX = /^kmj-codebridge-supervisor-[a-z0-9-]{1,40}$/;
function hash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
export async function verifyPreparedSupervisor(backupDir, options = {}) {
  if (process.platform !== "win32" && !options.mockClient)
    throw new Error("WINDOWS_ONLY");
  const manifest = JSON.parse(
    fs
      .readFileSync(path.join(backupDir, "manifest.json"), "utf8")
      .replace(/^\uFEFF/, ""),
  );
  if (
    manifest.schema !== 2 ||
    manifest.taskName !== "KMJ-CodeBridge-Supervisor" ||
    manifest.tokenCreatedByInstaller !== true ||
    !Array.isArray(manifest.files)
  )
    throw new Error("INVALID_INSTALL_MANIFEST");
  const configEntry = manifest.files.find(
    (f) => path.win32.basename(f.source).toLowerCase() === "supervisor.json",
  );
  if (!configEntry || hash(configEntry.backup) !== configEntry.sha256)
    throw new Error("SUPERVISOR_BACKUP_MISMATCH");
  const cfg = JSON.parse(fs.readFileSync(configEntry.backup, "utf8"));
  if (
    !PIPE_PREFIX.test(cfg.pipeName) ||
    cfg.tokenFile !== manifest.tokenFile ||
    hash(cfg.tokenFile) !== manifest.tokenSha256
  )
    throw new Error("SUPERVISOR_TOKEN_MISMATCH");
  const runtime = cfg.agent?.installDir;
  if (
    typeof runtime !== "string" ||
    path.win32.basename(runtime).toLowerCase() !== PINNED_RELEASE_SHA ||
    !fs.existsSync(path.join(runtime, "src", "supervisor-client.js"))
  )
    throw new Error("SUPERVISOR_RUNTIME_NOT_PINNED");
  const request = options.mockClient
    ? options.mockClient
    : (
        await import(
          pathToFileURL(path.join(runtime, "src", "supervisor-client.js"))
        )
      ).windowsSupervisorRequest;
  const pipePath = "\\\\.\\pipe\\" + cfg.pipeName;
  const result = await request(
    { pipePath, tokenFile: cfg.tokenFile },
    { op: "status", service: "agent" },
    { timeoutMs: 3000 },
  );
  if (
    result?.supervisor !== "windows-native" ||
    result?.service !== "agent" ||
    result?.platform !== "win32"
  )
    throw new Error("SUPERVISOR_INVALID_HEALTH");
  return { supervisor: "windows-native", verified: true, agentWired: false };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 3) throw new Error("BACKUP_DIR_REQUIRED");
    await verifyPreparedSupervisor(process.argv[2]);
    console.log("SUPERVISOR_HMAC_STATUS=PASS");
    console.log("AGENT_HANDOFF=PENDING");
  } catch {
    // Never leak path, token, agent config, exception stack or transport data.
    console.error("SUPERVISOR_HMAC_STATUS=FAIL");
    process.exitCode = 1;
  }
}
