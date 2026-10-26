#!/usr/bin/env node
// Recover only the established fixed refresh unit; never starts an agent or gateway.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const unitText =
  "[Unit]\nDescription=KMJ CodeBridge fixed Main Platform agent refresh\nAfter=network-online.target\nWants=network-online.target\n# All file, credential and project preconditions are verified by the fixed\n# refresh wrapper before any mutation. Do not silently skip this oneshot:\n# a failed validation must return a real nonzero exit for operator diagnosis.\n\n[Service]\nType=oneshot\nUser=root\nGroup=root\nWorkingDirectory=/opt/kmj-codebridge-agent\nEnvironment=CODEBRIDGE_RUNTIME=/opt/kmj-codebridge-agent\nExecStart=/bin/bash /opt/kmj-codebridge-agent/scripts/refresh-main-platform-agent.sh\nNoNewPrivileges=true\nPrivateTmp=true\nProtectSystem=strict\nProtectHome=read-only\nProtectKernelTunables=true\nProtectKernelModules=true\nProtectControlGroups=true\nRestrictSUIDSGID=true\nLockPersonality=true\nRestrictAddressFamilies=AF_UNIX\nReadWritePaths=/etc/kmj-codebridge-main-platform /etc/systemd/system /var/lib/kmj-codebridge-kmj-main-platform /srv/kmj-codebridge-projects/kmj-main-platform /opt/kmj-codebridge-main-platform-stage\nUMask=0077\n";
const runtime = "/opt/kmj-codebridge-agent";
const unitFile =
  "/etc/systemd/system/kmj-codebridge-main-platform-refresh.service";
const pins = {
  "scripts/refresh-main-platform-agent.sh":
    "4ed2cee74425f62fc0d8b7f795162c0416c16309",
  "scripts/stage-main-platform-runtime.js":
    "7e004ab53883ecdc8b4d1d938ab52a8fa02143ca",
  "scripts/setup-main-platform-agent.sh":
    "b53308821ac33d3e9b51d3927e41c8f43c6e421c",
};
function protectedFile(file, privateFile = false) {
  const st = fs.lstatSync(file);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    st.uid !== 0 ||
    st.mode & (privateFile ? 0o077 : 0o022)
  ) {
    throw Error("PROTECTED_FILE_UNSAFE");
  }
  return st;
}
function protectedDirectory(dir) {
  const st = fs.lstatSync(dir);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== 0 ||
    st.mode & 0o022
  )
    throw Error("PROTECTED_DIRECTORY_UNSAFE");
}
export function publishMissingUnit(file, reload) {
  try {
    const st = fs.lstatSync(file);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid() ||
      st.mode & 0o022
    )
      throw Error("EXISTING_UNIT_UNSAFE");
    if (fs.readFileSync(file, "utf8") !== unitText)
      throw Error("EXISTING_UNIT_DRIFT");
    return "unchanged";
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o644,
  );
  let created;
  try {
    created = fs.fstatSync(fd);
    fs.writeFileSync(fd, unitText);
    fs.fchmodSync(fd, 0o644);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {}
    if (created && fs.lstatSync(file).ino === created.ino) fs.unlinkSync(file);
    throw error;
  }
  try {
    reload();
  } catch (error) {
    const now = fs.lstatSync(file);
    if (
      now.ino === created.ino &&
      now.dev === created.dev &&
      now.isFile() &&
      !now.isSymbolicLink()
    )
      fs.unlinkSync(file);
    try {
      reload();
    } catch {}
    throw error;
  }
  return "installed";
}
function preflight() {
  if (process.getuid?.() !== 0) throw Error("ROOT_REQUIRED");
  if (
    execFileSync("/usr/bin/hostname", ["-s"], { encoding: "utf8" }).trim() !==
    "KMJ-elite"
  )
    throw Error("WRONG_HOST");
  for (const dir of [
    "/opt",
    runtime,
    runtime + "/scripts",
    "/etc",
    "/etc/systemd",
    "/etc/systemd/system",
  ])
    protectedDirectory(dir);
  for (const [relative, hash] of Object.entries(pins)) {
    const file = runtime + "/" + relative;
    protectedFile(file);
    const bytes = fs.readFileSync(file);
    const blob = crypto
      .createHash("sha1")
      .update("blob " + bytes.length + "\0")
      .update(bytes)
      .digest("hex");
    if (blob !== hash) throw Error("PINNED_SOURCE_MISMATCH");
  }
  // An existing enrollment is mandatory. Neither credentials nor configuration
  // values are returned, copied or modified by this installer.
  const config = "/etc/kmj-codebridge-main-platform/agent.json";
  const st = fs.lstatSync(config);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.mode & 0o077)
    throw Error("ENROLLMENT_CONFIG_UNSAFE");
  for (const dir of [
    "/var/lib/kmj-codebridge-kmj-main-platform",
    "/srv/kmj-codebridge-projects/kmj-main-platform",
    "/opt/kmj-codebridge-main-platform-stage",
  ])
    if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink())
      throw Error("REQUIRED_DIRECTORY_UNSAFE");
  const unit = execFileSync(
    "/usr/bin/systemctl",
    [
      "show",
      "kmj-codebridge-kmj-main-platform.service",
      "-p",
      "LoadState",
      "--value",
    ],
    { encoding: "utf8", timeout: 10000 },
  ).trim();
  if (unit !== "loaded") throw Error("EXISTING_AGENT_UNIT_REQUIRED");
}
function main() {
  if (
    process.argv.length !== 3 ||
    !["--check", "--install"].includes(process.argv[2])
  )
    throw Error("USE_CHECK_OR_INSTALL_ONLY");
  preflight();
  console.log("KMJ_REFRESH_SOURCE_AND_ENROLLMENT=PINNED_PASS");
  if (process.argv[2] === "--check") {
    console.log("KMJ_REFRESH_RECOVERY=CHECK_ONLY_NO_CHANGES");
    return;
  }
  const result = publishMissingUnit(unitFile, () =>
    execFileSync("/usr/bin/systemctl", ["daemon-reload"], {
      timeout: 30000,
      stdio: "pipe",
    }),
  );
  console.log("KMJ_REFRESH_UNIT=" + result.toUpperCase());
  console.log("KMJ_AGENT_RESTART=NOT_ATTEMPTED");
  console.log("KMJ_PRODUCTION_CHANGE=NONE");
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    const safe = /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "OS_PREFLIGHT_OR_RELOAD";
    console.error("KMJ_REFRESH_RECOVERY=BLOCKED_" + safe);
    process.exitCode = 2;
  }
}
