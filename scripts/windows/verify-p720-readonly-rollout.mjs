import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = "4828da1e3a82f8c2372f648836e985626d8681f6";
const ROOT = "D:\\KMJ-HyperSpeed\\codebridge-releases";
const PROJECT = "D:\\KMJ-HyperSpeed\\projects\\kmj-codebridge";
const eq = (a, b) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

export async function verifyP720ReadOnlyProfile(mode, runtime, configPath) {
  if (process.platform !== "win32") throw Error("WINDOWS_REQUIRED");
  if (mode !== "stage" && mode !== "live") throw Error("INVALID_MODE");
  if (!eq(path.win32.dirname(runtime), ROOT) ||
      path.win32.basename(runtime).toLowerCase() !== SHA)
    throw Error("UNTRUSTED_RELEASE_ROOT");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!Array.isArray(cfg.projects) || cfg.projects.length !== 0 ||
      !Array.isArray(cfg.readOnlyProjects) || cfg.readOnlyProjects.length !== 1 ||
      cfg.readOnlyProjects[0].id !== "kmj-codebridge" ||
      !eq(cfg.readOnlyProjects[0].repoRoot, PROJECT))
    throw Error("UNAPPROVED_PROJECT_SCOPE");
  const { createWindowsSupervisorConfigSchema } = await import(
    pathToFileURL(path.join(runtime, "src", "windows-supervisor.js"))
  );
  createWindowsSupervisorConfigSchema(path.win32).parse(cfg);
  if (mode === "stage") return { stage: true };
  const { windowsSupervisorRequest } = await import(
    pathToFileURL(path.join(runtime, "src", "supervisor-client.js"))
  );
  const client = { pipePath: "\\\\.\\pipe\\" + cfg.pipeName, tokenFile: cfg.tokenFile };
  const status = await windowsSupervisorRequest(
    client, { op: "status", service: "agent" }, { timeoutMs: 3500 }
  );
  if (status?.supervisor !== "windows-native" ||
      status?.platform !== "win32" || status?.service !== "agent")
    throw Error("HMAC_STATUS_INVALID");
  const result = await windowsSupervisorRequest(
    client, { op: "project_status", projectId: "kmj-codebridge" },
    { timeoutMs: 3500 }
  );
  if (result?.projectId !== "kmj-codebridge" ||
      result.present !== true || result.gitCheckout !== true ||
      result.verification?.supported !== false ||
      result.verification?.allowFetch !== false ||
      !Array.isArray(result.verification?.stages) ||
      result.verification.stages.length !== 0)
    throw Error("READONLY_PROJECT_STATUS_INVALID");
  // A read-only project must never authorize even a prepare operation.
  try {
    await windowsSupervisorRequest(
      client, { op: "project_verify_prepare", projectId: "kmj-codebridge",
        sha: SHA }, { timeoutMs: 3500 }
    );
    throw Error("READONLY_WRITE_GUARD_FAILED");
  } catch (error) {
    if (error?.message === "READONLY_WRITE_GUARD_FAILED")
      throw error;
    if (error?.message !== "SUPERVISOR_PROJECT_NOT_AUTHORIZED")
      throw Error("READONLY_WRITE_REFUSAL_NOT_CONFIRMED");
  }
  return { hmac: true, project: true, writesDenied: true };
}
if (process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5) throw Error("ARGUMENTS_REQUIRED");
    const result = await verifyP720ReadOnlyProfile(
      process.argv[2], process.argv[3], process.argv[4]
    );
    console.log(result.stage
      ? "KMJ_PROJECT_ROLLOUT_STAGE=PASS"
      : "KMJ_PROJECT_ROLLOUT_LIVE=HMAC_AND_READONLY_PASS");
  } catch {
    // No secret path, token, stack trace, arbitrary server data or config.
    console.error("KMJ_PROJECT_ROLLOUT_VERIFICATION=FAIL");
    process.exitCode = 1;
  }
}
