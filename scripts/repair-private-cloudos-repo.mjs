#!/usr/bin/env node
// Owner-run, zero-new-service gateway config recovery utility.
// Never restart the gateway, print credentials, relax repo grants or execute AI.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  planCloudOSAllowlist,
  verifyCloudOSPrivateRepoGrant,
} from "../src/cloudos-private-repo-allowlist-patch.js";

const hash = (data) => createHash("sha256").update(data).digest("hex");
function stop(code) {
  console.error(code);
  process.exitCode = 3;
}
async function main() {
  const [mode, configPath, expected] = process.argv.slice(2);
  if (
    !["--check", "--apply"].includes(mode) ||
    !configPath ||
    !path.isAbsolute(configPath) ||
    (mode === "--apply" &&
      (typeof expected !== "string" || !/^[a-f0-9]{64}$/.test(expected))) ||
    (mode === "--check" && expected !== undefined)
  )
    throw new Error(
      "USAGE: node scripts/repair-private-cloudos-repo.mjs --check ABSOLUTE_CONFIG | --apply ABSOLUTE_CONFIG EXPECTED_CONFIG_SHA256",
    );
  if (process.platform !== "linux") throw new Error("REPO_REPAIR_LINUX_ONLY");
  const stat = fs.lstatSync(configPath);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    fs.realpathSync(configPath) !== configPath
  )
    throw new Error("REPO_REPAIR_CONFIG_PATH_UNSAFE");
  const before = fs.readFileSync(configPath);
  if (before.byteLength > 2 * 1024 * 1024)
    throw new Error("REPO_REPAIR_CONFIG_TOO_LARGE");
  const originalHash = hash(before);
  if (mode === "--apply" && originalHash !== expected)
    throw new Error("REPO_REPAIR_CONFLICT");
  let raw;
  try {
    raw = JSON.parse(before.toString("utf8"));
  } catch {
    throw new Error("REPO_REPAIR_CONFIG_INVALID_JSON");
  }
  const plan = planCloudOSAllowlist(raw);
  // A private grant is compulsory even if the repo is already listed.
  await verifyCloudOSPrivateRepoGrant(process.env[plan.tokenEnv]);
  console.log("REPO_REPAIR_PRIVATE_GRANT=PASS");
  console.log("REPO_REPAIR_INPUT_SHA256=" + originalHash);
  console.log("REPO_REPAIR_ALREADY_ALLOWED=" + plan.alreadyAllowed);
  if (mode === "--check" || plan.alreadyAllowed) {
    console.log("REPO_REPAIR_WRITES=NONE");
    return;
  }
  if (process.getuid?.() !== 0)
    throw new Error("REPO_REPAIR_APPLY_REQUIRES_ROOT");
  const nextData = Buffer.from(
    JSON.stringify(plan.config, null, 2) + "\n",
    "utf8",
  );
  const root = path.dirname(configPath);
  const backup = configPath + ".kmj-backup-" + originalHash.slice(0, 16);
  const temp = configPath + ".kmj-next-" + process.pid;
  let tempExists = false;
  let backupExists = false;
  try {
    // Never overwrite an existing backup; preserve original protected mode
    // and ownership. All changed files stay on the same filesystem.
    fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
    backupExists = true;
    fs.chmodSync(backup, stat.mode & 0o777);
    fs.chownSync(backup, stat.uid, stat.gid);
    const fd = fs.openSync(
      temp,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      stat.mode & 0o777,
    );
    tempExists = true;
    try {
      fs.writeFileSync(fd, nextData);
      fs.fchmodSync(fd, stat.mode & 0o777);
      fs.fchownSync(fd, stat.uid, stat.gid);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const currentStat = fs.lstatSync(configPath);
    if (
      !currentStat.isFile() ||
      currentStat.isSymbolicLink() ||
      currentStat.ino !== stat.ino ||
      currentStat.dev !== stat.dev ||
      hash(fs.readFileSync(configPath)) !== originalHash
    )
      throw new Error("REPO_REPAIR_RACE_CONFLICT");
    fs.renameSync(temp, configPath);
    tempExists = false;
    const dirfd = fs.openSync(root, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(dirfd);
    } finally {
      fs.closeSync(dirfd);
    }
  } catch (error) {
    if (tempExists) fs.rmSync(temp, { force: true });
    // If the write failed, a fresh backup is preserved for investigation.
    if (backupExists) console.error("REPO_REPAIR_BACKUP_PRESERVED=YES");
    throw error;
  }
  console.log("REPO_REPAIR_APPLIED=YES");
  console.log("REPO_REPAIR_NEW_SHA256=" + hash(nextData));
  console.log("REPO_REPAIR_BACKUP=" + backup);
  console.log("REPO_REPAIR_GATEWAY_RESTARTED=NO");
  console.log("REPO_REPAIR_LIVE_ACCESS_VERIFIED=NO");
}
main().catch((error) =>
  stop(
    typeof error?.message === "string" &&
      /^[A-Z][A-Z0-9_: .-]{2,160}$/.test(error.message)
      ? error.message
      : "REPO_REPAIR_ABORTED",
  ),
);
