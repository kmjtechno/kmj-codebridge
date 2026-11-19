// P520 existing CodeBridge agent -> persistent Windows Supervisor binding preflight.
// SOURCE-ONLY: never edits agent.json, starts/stops a task, or restarts an agent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";

const WIN = path.win32;
export const ROOT = "C:\\ProgramData\\KMJ-CodeBridge\\P520";
export const RELEASE_SHA = "b652b29beafb9b14e42b0078bfb9571fef5b3271";
export const RELEASE = WIN.join(ROOT, "releases", RELEASE_SHA);
export const SUPERVISOR_JSON = WIN.join(ROOT, "supervisor.json");
export const TOKEN = WIN.join(ROOT, "supervisor.token");
export const PIPE = "\\\\.\\pipe\\kmj-codebridge-supervisor-p520";
export const DEVICE_ID = "kmj-kmj-codebridge-desktop-5fvjmet";

const deny = (reason) => { throw new Error(reason); };
const same = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  WIN.isAbsolute(a) &&
  WIN.isAbsolute(b) &&
  WIN.normalize(a).toLowerCase() === WIN.normalize(b).toLowerCase();

function nontrivialAgentPath(p) {
  return typeof p === "string" &&
    WIN.isAbsolute(p) &&
    !p.startsWith("\\\\") &&
    WIN.basename(p).toLowerCase() === "agent.json" &&
    !p.includes("..");
}

export function verifyBindingSnapshot(supervisor, current, proposed) {
  if (
    !supervisor || !current || !proposed ||
    typeof supervisor !== "object" || Array.isArray(supervisor) ||
    typeof current !== "object" || Array.isArray(current) ||
    typeof proposed !== "object" || Array.isArray(proposed)
  ) deny("BINDING_JSON_INVALID");

  const agentPath = supervisor.agent?.configPath;
  if (
    supervisor.pipeName !== "kmj-codebridge-supervisor-p520" ||
    !same(supervisor.tokenFile, TOKEN) ||
    !same(supervisor.agent?.installDir, RELEASE) ||
    !nontrivialAgentPath(agentPath) ||
    !Array.isArray(supervisor.projects) ||
    supervisor.projects.length !== 0 ||
    !Array.isArray(supervisor.readOnlyProjects) ||
    supervisor.readOnlyProjects.length !== 0 ||
    Object.hasOwn(supervisor.agent ?? {}, "restartTask")
  ) deny("BINDING_SUPERVISOR_SCOPE_CHANGED");

  if (
    current.id !== DEVICE_ID ||
    !["https://kmjtechno.com", "https://kmjtechno.com/"].includes(current.gateway) ||
    !Array.isArray(current.projects) ||
    current.projects.length !== 1 ||
    current.projects[0]?.id !== "kmj-codebridge" ||
    ["supervisorPipe", "supervisorTokenFile", "supervisorSocket"].some((k) => Object.hasOwn(current, k))
  ) deny("BINDING_EXISTING_AGENT_IDENTITY_CHANGED");

  if (
    proposed.supervisorPipe !== PIPE ||
    !same(proposed.supervisorTokenFile, TOKEN) ||
    Object.hasOwn(proposed, "supervisorSocket")
  ) deny("BINDING_PROPOSAL_ENDPOINT_CHANGED");

  const copy = Object.fromEntries(
    Object.entries(proposed).filter(([key]) =>
      key !== "supervisorPipe" && key !== "supervisorTokenFile"
    ),
  );
  if (!isDeepStrictEqual(copy, current))
    deny("BINDING_PROPOSAL_UNAPPROVED_DIFFERENCE");

  return { verified: true, agentConfigPath: agentPath };
}

function readTrustedJson(file) {
  if (!WIN.isAbsolute(file) || file.startsWith("\\\\"))
    deny("BINDING_PATH_UNSAFE");
  // Refuse reparse points, symlinks, special files and oversized JSON.
  const parsed = WIN.parse(file);
  let ancestor = parsed.root;
  const relative = WIN.relative(parsed.root, WIN.dirname(file)).split("\\").filter(Boolean);
  for (const part of relative) {
    ancestor = WIN.join(ancestor, part);
    const entry = fs.lstatSync(ancestor);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      deny("BINDING_DIRECTORY_UNTRUSTED");
  }
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 10 || before.size > 1024 * 1024)
    deny("BINDING_JSON_FILE_UNTRUSTED");
  const data = fs.readFileSync(file, "utf8");
  const after = fs.lstatSync(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    deny("BINDING_JSON_CHANGED_DURING_READ");
  try { return JSON.parse(data); } catch { deny("BINDING_JSON_PARSE_FAILED"); }
}

export function inspectLocalBinding({
  platform = process.platform,
  hostname = os.hostname(),
  read = readTrustedJson,
} = {}) {
  if (platform !== "win32" || hostname.toUpperCase() !== "DESKTOP-5FVJMET")
    deny("BINDING_WRONG_DEVICE");
  const supervisor = read(SUPERVISOR_JSON);
  const agent = supervisor.agent?.configPath;
  if (!nontrivialAgentPath(agent)) deny("BINDING_AGENT_PATH_UNVERIFIED");
  const current = read(agent);
  const proposed = read(agent + ".proposed");
  const result = verifyBindingSnapshot(supervisor, current, proposed);
  return { verified: result.verified };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--inspect")
      deny("BINDING_INSPECT_ONLY");
    inspectLocalBinding();
    console.log("P520_AGENT_PROPOSAL_EXACT_ONLY=PASS");
    console.log("P520_AGENT_BINDING_PREFLIGHT=PASS");
    console.log("P520_AGENT_CONFIG_MUTATION=NONE");
    console.log("P520_AGENT_RESTART=NOT_EXECUTED");
    console.log("P520_PHYSICAL_RESTORE=NOT_EXECUTED");
    console.log("PRODUCTION_APPROVAL=NOT_GRANTED");
  } catch (e) {
    const v = String(e?.message ?? "");
    const code = /^[A-Z][A-Z0-9_]{3,90}$/.test(v) ? v : "UNVERIFIED";
    console.log("P520_AGENT_BINDING_PREFLIGHT=BLOCKED_" + code);
    console.log("P520_AGENT_CONFIG_MUTATION=NONE");
    console.log("PRODUCTION_APPROVAL=NOT_GRANTED");
    process.exitCode = 2;
  }
}
