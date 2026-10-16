// Read-only preflight for the P720 supervisor-to-agent handoff.
// No secret/config output, arbitrary plugin loading, process termination,
// network activity, or file mutation.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const ROOT = "D:\\KMJ-HyperSpeed\\private\\p720-codebridge";
const RELEASE_SHA = "e3587be842dcc701236b54a2e1de90238a5c3429";
const WIN = path.win32;
const agentPath = WIN.join(ROOT, "agent.json");
const proposedPath = agentPath + ".proposed";
const configPath = WIN.join(ROOT, "supervisor.json");
const tokenPath = WIN.join(ROOT, "supervisor.token");
const pipe = "\\\\.\\pipe\\kmj-codebridge-supervisor-p720";
const eqPath = (a, b) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const digest = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function assertRegularFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Error("HANDOFF_UNTRUSTED_FILE");
}
export function verifyP720HandoffSnapshot(backupDir) {
  if (typeof backupDir !== "string" || !WIN.isAbsolute(backupDir))
    throw Error("HANDOFF_BACKUP_PATH_INVALID");
  const backupRoot = "D:\\KMJ-HyperSpeed\\private\\backups";
  const relative = WIN.relative(backupRoot, backupDir);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith("..\\") ||
    WIN.isAbsolute(relative)
  )
    throw Error("HANDOFF_BACKUP_OUT_OF_SCOPE");
  const manifestPath = WIN.join(backupDir, "manifest.json");
  for (const file of [
    manifestPath,
    agentPath,
    proposedPath,
    configPath,
    tokenPath,
  ])
    assertRegularFile(file);
  const m = JSON.parse(
    fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/, ""),
  );
  if (
    m.schema !== 2 ||
    m.taskName !== "KMJ-CodeBridge-Supervisor" ||
    m.tokenCreatedByInstaller !== true ||
    !Array.isArray(m.files) ||
    m.files.length !== 2 ||
    !eqPath(m.tokenFile, tokenPath)
  )
    throw Error("HANDOFF_MANIFEST_INVALID");
  if (digest(tokenPath) !== m.tokenSha256) throw Error("HANDOFF_TOKEN_CHANGED");
  if (digest(proposedPath) !== m.proposedSha256)
    throw Error("HANDOFF_PROPOSAL_CHANGED");
  for (const entry of m.files) {
    if (!eqPath(entry.source, agentPath) && !eqPath(entry.source, configPath))
      throw Error("HANDOFF_FOREIGN_BACKUP_ENTRY");
    if (!eqPath(WIN.dirname(entry.backup), backupDir))
      throw Error("HANDOFF_BACKUP_ENTRY_OUT_OF_SCOPE");
    assertRegularFile(entry.backup);
    if (digest(entry.backup) !== entry.sha256)
      throw Error("HANDOFF_BACKUP_CHANGED");
  }
  const agentEntries = m.files.filter((e) => eqPath(e.source, agentPath));
  const supervisorEntries = m.files.filter((e) => eqPath(e.source, configPath));
  if (agentEntries.length !== 1 || supervisorEntries.length !== 1)
    throw Error("HANDOFF_BACKUP_ENTRY_MISSING");
  if (
    digest(agentPath) !== agentEntries[0].sha256 ||
    digest(configPath) !== supervisorEntries[0].sha256
  )
    throw Error("HANDOFF_ORIGINAL_CONFIG_CHANGED");
  const agent = JSON.parse(fs.readFileSync(agentPath, "utf8"));
  const proposal = JSON.parse(fs.readFileSync(proposedPath, "utf8"));
  const supervisor = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (
    Object.hasOwn(agent, "supervisorPipe") ||
    Object.hasOwn(agent, "supervisorTokenFile") ||
    Object.hasOwn(agent, "supervisorSocket")
  )
    throw Error("HANDOFF_AGENT_ALREADY_WIRED");
  if (
    proposal.supervisorPipe !== pipe ||
    !eqPath(proposal.supervisorTokenFile, tokenPath) ||
    supervisor.pipeName !== "kmj-codebridge-supervisor-p720" ||
    !eqPath(supervisor.tokenFile, tokenPath) ||
    WIN.basename(supervisor.agent?.installDir ?? "").toLowerCase() !==
      RELEASE_SHA ||
    !eqPath(supervisor.agent?.configPath, agentPath)
  )
    throw Error("HANDOFF_SUPERVISOR_SCOPE_MISMATCH");
  const originalOnly = { ...proposal };
  delete originalOnly.supervisorPipe;
  delete originalOnly.supervisorTokenFile;
  assert.deepStrictEqual(
    originalOnly,
    agent,
    "HANDOFF_PROPOSAL_HAS_UNAPPROVED_CHANGES",
  );
  if (
    agent.id !== "kmj-p720-desktop-k3ahhem" ||
    !Array.isArray(agent.projects) ||
    agent.projects.length !== 1 ||
    agent.projects[0].id !== "kmj-codebridge" ||
    !eqPath(
      agent.projects[0].root,
      "D:\\KMJ-HyperSpeed\\projects\\kmj-codebridge",
    ) ||
    !eqPath(agent.stateDir, WIN.join(ROOT, "state")) ||
    !["https://kmjtechno.com", "https://kmjtechno.com/"].includes(agent.gateway)
  )
    throw Error("HANDOFF_AGENT_SCOPE_MISMATCH");
  return Object.freeze({
    verified: true,
    originalSha256: digest(agentPath),
    proposedSha256: digest(proposedPath),
    supervisorSha: RELEASE_SHA,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    if (process.platform !== "win32" || process.argv.length !== 3)
      throw Error("HANDOFF_WINDOWS_AND_BACKUP_REQUIRED");
    verifyP720HandoffSnapshot(process.argv[2]);
    console.log("KMJ_HANDOFF_CONFIG_PREFLIGHT=PASS");
    console.log("KMJ_HANDOFF_AGENT_SWITCH=NOT_STARTED");
  } catch {
    console.error("KMJ_HANDOFF_CONFIG_PREFLIGHT=FAIL");
    process.exitCode = 1;
  }
}
