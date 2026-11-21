// P520 existing-agent POST-handoff verifier. Strict read-only, no agent
// restart, no task changes, no secrets/paths/process details in stdout.
// This verifies that the final config is the previously exact proposed
// two-field additive binding AND the real native Supervisor HMAC still works.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { pathToFileURL } from "node:url";
import {
  PIPE,
  TOKEN,
  SUPERVISOR_JSON,
  verifyBindingSnapshot,
} from "./P520-EXACT-AGENT-BINDING-PREFLIGHT-20261119.mjs";
import { probePersistent } from "./P520-PERSISTENT-HMAC-VERIFY-20261119.mjs";

const WIN = path.win32;
const block = (reason) => {
  throw new Error(reason);
};

function trustedJson(file) {
  if (
    typeof file !== "string" ||
    !WIN.isAbsolute(file) ||
    file.startsWith("\\\\")
  )
    block("POST_BINDING_UNTRUSTED_PATH");
  const root = WIN.parse(file).root;
  let current = root;
  for (const part of WIN.relative(root, WIN.dirname(file))
    .split("\\")
    .filter(Boolean)) {
    current = WIN.join(current, part);
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      block("POST_BINDING_DIRECTORY_SYMLINK");
  }
  const before = fs.lstatSync(file);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 10 ||
    before.size > 1024 * 1024
  )
    block("POST_BINDING_CONFIG_UNTRUSTED");
  const data = fs.readFileSync(file, "utf8");
  const after = fs.lstatSync(file);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    before.ino !== after.ino ||
    before.dev !== after.dev
  )
    block("POST_BINDING_CONFIG_CHANGED");
  try {
    return JSON.parse(data);
  } catch {
    block("POST_BINDING_CONFIG_PARSE_FAILED");
  }
}

export function validatePostBinding(supervisor, current, proposed) {
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    !proposed ||
    typeof proposed !== "object" ||
    Array.isArray(proposed)
  )
    block("POST_BINDING_JSON_INVALID");
  if (
    current.supervisorPipe !== PIPE ||
    typeof current.supervisorTokenFile !== "string" ||
    WIN.normalize(current.supervisorTokenFile).toLowerCase() !==
      WIN.normalize(TOKEN).toLowerCase() ||
    Object.hasOwn(current, "supervisorSocket")
  )
    block("POST_BINDING_PIPE_IDENTITY");
  if (!isDeepStrictEqual(current, proposed))
    block("POST_BINDING_NOT_EXACT_OWNER_PROPOSAL");
  const prebound = Object.fromEntries(
    Object.entries(current).filter(
      ([key]) => key !== "supervisorPipe" && key !== "supervisorTokenFile",
    ),
  );
  verifyBindingSnapshot(supervisor, prebound, proposed);
  return { verified: true, mode: "BOUND" };
}

export async function inspectPostBinding({
  platform = process.platform,
  hostname = os.hostname(),
  read = trustedJson,
  hmac = probePersistent,
} = {}) {
  if (platform !== "win32" || hostname.toUpperCase() !== "DESKTOP-5FVJMET")
    block("POST_BINDING_WRONG_DEVICE");
  const supervisor = read(SUPERVISOR_JSON);
  const agentPath = supervisor?.agent?.configPath;
  if (
    typeof agentPath !== "string" ||
    !WIN.isAbsolute(agentPath) ||
    WIN.basename(agentPath).toLowerCase() !== "agent.json" ||
    agentPath.includes("..")
  )
    block("POST_BINDING_AGENT_PATH_INVALID");
  const current = read(agentPath);
  const proposed = read(agentPath + ".proposed");
  const configResult = validatePostBinding(supervisor, current, proposed);
  const proof = await hmac();
  if (proof?.verified !== true || proof?.limitedCapabilities !== true)
    block("POST_BINDING_HMAC_NOT_VERIFIED");
  return configResult;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--inspect")
      block("POST_BINDING_READ_ONLY_MODE");
    await inspectPostBinding();
    console.log("P520_POST_HANDOFF_CONFIG=PASS");
    console.log("P520_POST_HANDOFF_HMAC=PASS");
    console.log("P520_POST_HANDOFF_STATE=BOUND_VERIFIED");
    console.log("P520_AGENT_RESTART=NOT_EXECUTED");
    console.log("P520_PHYSICAL_RESTORE=NOT_EXECUTED");
    console.log("PRODUCTION_APPROVAL=NOT_GRANTED");
  } catch (error) {
    const code = String(error?.message ?? "");
    console.log(
      "P520_POST_HANDOFF_STATE=BLOCKED_" +
        (/^[A-Z][A-Z0-9_]{3,90}$/.test(code) ? code : "UNVERIFIED"),
    );
    console.log("P520_AGENT_RESTART=NOT_EXECUTED");
    process.exitCode = 2;
  }
}
