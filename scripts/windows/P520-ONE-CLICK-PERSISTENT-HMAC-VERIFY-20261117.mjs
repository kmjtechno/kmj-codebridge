// P520 persistent Windows Supervisor HMAC probe; never launches a listener.
// This is an explicit owner activation gate, not an agent enrollment proof.
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const sha = "b652b29beafb9b14e42b0078bfb9571fef5b3271";
const root = "C:\\ProgramData\\KMJ-CodeBridge\\P520";
const expectedRelease = path.win32.join(root, "releases", sha);
const expectedConfig = path.win32.join(root, "supervisor.json");
const expectedToken = path.win32.join(root, "supervisor.token");

function same(a, b) {
  return (
    typeof a === "string" &&
    path.win32.normalize(a).toLowerCase() ===
      path.win32.normalize(b).toLowerCase()
  );
}

async function run() {
  if (process.platform !== "win32") throw new Error("WINDOWS_ONLY");
  const release = process.argv[2];
  const configPath = process.argv[3];
  if (!same(release, expectedRelease) || !same(configPath, expectedConfig))
    throw new Error("PATH_MISMATCH");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (
    config.pipeName !== "kmj-codebridge-supervisor-p520" ||
    !same(config.tokenFile, expectedToken) ||
    !same(config.agent?.installDir, expectedRelease) ||
    !Array.isArray(config.projects) ||
    config.projects.length !== 0 ||
    !Array.isArray(config.readOnlyProjects) ||
    config.readOnlyProjects.length !== 0 ||
    "restartTask" in (config.agent ?? {})
  ) {
    throw new Error("CAPABILITIES_INVALID");
  }
  const { windowsSupervisorRequest } = await import(
    pathToFileURL(path.win32.join(release, "src", "supervisor-client.js")).href
  );
  const client = {
    pipePath: "\\\\.\\pipe\\kmj-codebridge-supervisor-p520",
    tokenFile: expectedToken,
  };
  const status = await windowsSupervisorRequest(
    client,
    { op: "status", service: "agent" },
    { timeoutMs: 2500 },
  );
  if (
    status?.supervisor !== "windows-native" ||
    status?.service !== "agent" ||
    status?.restart?.supported !== false ||
    status?.update?.supported !== false ||
    status?.activeProcessRuntime?.verified !== false ||
    status?.runtimeScope !== "configured-install-dir"
  ) {
    throw new Error("AUTHENTICATED_STATUS_INVALID");
  }
  const validate = await windowsSupervisorRequest(
    client,
    { op: "config_validate", service: "agent" },
    { timeoutMs: 2500 },
  );
  if (validate?.valid !== true) throw new Error("CONFIG_INVALID");
  console.log("P520_PERSISTENT_HMAC_STATUS=PASS");
  console.log("P520_PERSISTENT_HMAC_CONFIG=PASS");
}

try {
  await run();
} catch {
  console.error("P520_PERSISTENT_HMAC=BLOCKED");
  process.exitCode = 2;
}
