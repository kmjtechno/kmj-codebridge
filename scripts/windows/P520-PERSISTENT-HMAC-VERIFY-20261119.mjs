// P520 persistent Supervisor: authenticated status probe, no task or agent mutation.
// This never reads token contents into stdout; the pinned runtime handles HMAC.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_SHA = "b652b29beafb9b14e42b0078bfb9571fef5b3271";
export const ROOT = "C:\\ProgramData\\KMJ-CodeBridge\\P520";
export const RELEASE = path.win32.join(ROOT, "releases", RELEASE_SHA);
export const CONFIG = path.win32.join(ROOT, "supervisor.json");
export const TOKEN = path.win32.join(ROOT, "supervisor.token");
export const PIPE_NAME = "kmj-codebridge-supervisor-p520";
export const PIPE_PATH = "\\\\.\\pipe\\" + PIPE_NAME;

const same = (left, right) =>
  typeof left === "string" &&
  path.win32.normalize(left).toLowerCase() ===
    path.win32.normalize(right).toLowerCase();
const deny = (code) => {
  throw new Error(code);
};

export function validatePinnedConfig(cfg) {
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg))
    deny("CONFIG_FORMAT");
  if (
    cfg.pipeName !== PIPE_NAME ||
    !same(cfg.tokenFile, TOKEN) ||
    !same(cfg.agent?.installDir, RELEASE) ||
    typeof cfg.agent?.configPath !== "string" ||
    cfg.agent.configPath.length < 8 ||
    !Array.isArray(cfg.projects) ||
    cfg.projects.length !== 0 ||
    !Array.isArray(cfg.readOnlyProjects) ||
    cfg.readOnlyProjects.length !== 0 ||
    Object.hasOwn(cfg.agent, "restartTask")
  )
    deny("CONFIG_CAPABILITY_OR_IDENTITY_MISMATCH");
  return true;
}

export function validateStatus(status) {
  if (
    status?.supervisor !== "windows-native" ||
    status?.service !== "agent" ||
    status?.platform !== "win32" ||
    status?.restart?.supported !== false ||
    status?.update?.supported !== false ||
    status?.activeProcessRuntime?.verified !== false ||
    status?.runtimeScope !== "configured-install-dir"
  )
    deny("HMAC_STATUS_NOT_ATTESTED");
  return true;
}

function checkOrdinaryFile(file) {
  const item = fs.lstatSync(file);
  if (!item.isFile() || item.isSymbolicLink()) deny("UNSAFE_PINNED_FILE");
}

export async function probePersistent({
  platform = process.platform,
  hostname = os.hostname(),
  getConfig = () => JSON.parse(fs.readFileSync(CONFIG, "utf8")),
  checkFiles = () => {
    checkOrdinaryFile(CONFIG);
    checkOrdinaryFile(TOKEN);
    checkOrdinaryFile(path.win32.join(RELEASE, "src", "supervisor-client.js"));
  },
  request = async (req) => {
    const { windowsSupervisorRequest } = await import(
      pathToFileURL(path.win32.join(RELEASE, "src", "supervisor-client.js"))
        .href
    );
    return windowsSupervisorRequest(
      { pipePath: PIPE_PATH, tokenFile: TOKEN },
      req,
      { timeoutMs: 3000 },
    );
  },
} = {}) {
  if (platform !== "win32" || hostname.toUpperCase() !== "DESKTOP-5FVJMET")
    deny("WRONG_P520_DEVICE");
  checkFiles();
  validatePinnedConfig(getConfig());
  const status = await request({ op: "status", service: "agent" });
  validateStatus(status);
  const validation = await request({
    op: "config_validate",
    service: "agent",
  });
  if (validation?.valid !== true) deny("HMAC_CONFIG_NOT_VALID");
  return { verified: true, limitedCapabilities: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 2) deny("UNEXPECTED_ARGUMENTS");
    await probePersistent();
    console.log("P520_PERSISTENT_HMAC_STATUS=PASS");
    console.log("P520_PERSISTENT_HMAC_CONFIG=PASS");
    console.log("P520_NO_RESTART_CAPABILITY=PASS");
    console.log("P520_AGENT_CONFIG_CHANGE=NONE");
    console.log("P520_PG_STORAGE_RESTORE=NOT_EXECUTED");
    console.log("PRODUCTION_APPROVAL=NOT_GRANTED");
  } catch (error) {
    const code = String(error?.message ?? "");
    console.error(
      "P520_PERSISTENT_HMAC_STATUS=BLOCKED_" +
        (/^[A-Z0-9_]{4,90}$/.test(code) ? code : "REVIEW_REQUIRED"),
    );
    process.exitCode = 2;
  }
}
