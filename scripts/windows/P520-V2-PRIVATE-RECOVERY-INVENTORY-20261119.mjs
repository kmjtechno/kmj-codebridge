// P520 exact CE6 -> Licensing Hub candidate V2 PRIVATE inventory (read-only).
// Never reads private key contents, encrypted backup bytes, or signing material.
// Never changes image policy, downloads images, transfers data or runs restore.
import { lstatSync, readFileSync } from "node:fs";
import { join, win32 } from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { verifyWindowsPrivateAcl } from "./P520-OFFSITE-ACL-VERIFY-20261116.mjs";
import { fixedRecoveryPath } from "./P520-OFFSITE-CIPHER-READBACK-CANDIDATE-V2-20261119.mjs";

const HEX = /^[a-f0-9]{64}$/;
const CANDIDATE = "bd8975f0ee888a26013a6669e687db540f39f440";
const EXPECTED_NAME = "offsite-p520-bd8975f0ee88.tar.gz.age";

function lstatMaybe(file) {
  try { return lstatSync(file); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

export function classifyFile(stat, minBytes = 1, maxBytes = 10 * 1024 ** 3) {
  if (!stat) return "MISSING";
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      stat.size < minBytes || stat.size > maxBytes) return "UNSAFE_OR_INVALID";
  return "PRESENT_UNATTESTED";
}

export function classifyPolicy(stat, contents) {
  if (classifyFile(stat, 64, 66) !== "PRESENT_UNATTESTED") return "MISSING_OR_UNTRUSTED";
  if (typeof contents !== "string" || !HEX.test(contents.trim()) ||
      ![64, 65, 66].includes(contents.length)) return "MALFORMED";
  if (contents !== contents.trim() && !/^[a-f0-9]{64}\r?\n$/.test(contents))
    return "MALFORMED";
  return "FORMAT_PASS_NOT_OWNER_ATTESTED";
}

export function inspectV2({
  platform = process.platform,
  hostname = os.hostname(),
  localAppData = process.env.LOCALAPPDATA,
  stat = lstatMaybe,
  read = readFileSync,
  privateAcl = verifyWindowsPrivateAcl,
  run = (exe, args) => spawnSync(exe, args, {
    encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 2048,
  }),
} = {}) {
  if (platform !== "win32" || hostname.toUpperCase() !== "DESKTOP-5FVJMET")
    throw Error("WRONG_P520_HOST");
  if (typeof localAppData !== "string" || !win32.isAbsolute(localAppData) ||
      localAppData.startsWith("\\\\")) throw Error("LOCALAPPDATA_UNTRUSTED");
  const { parent, inbox, cipher } = fixedRecoveryPath(localAppData);
  if (!cipher.endsWith(EXPECTED_NAME)) throw Error("CANDIDATE_PATH_CHANGED");
  if (!privateAcl(parent) || !privateAcl(inbox)) throw Error("PRIVATE_ACL_INVALID");
  const policyPath = join(parent, "restore-image.sha256");
  const policyStat = stat(policyPath);
  let pin = null;
  let policy = "MISSING_OR_UNTRUSTED";
  if (policyStat && classifyFile(policyStat, 64, 66) === "PRESENT_UNATTESTED") {
    const raw = read(policyPath, "ascii");
    policy = classifyPolicy(policyStat, raw);
    if (policy === "FORMAT_PASS_NOT_OWNER_ATTESTED") pin = raw.trim();
  }
  const finalObject = classifyFile(stat(cipher), 256);
  const partialObject = classifyFile(stat(cipher + ".partial"), 256);
  let image = "NOT_CHECKED_NO_OWNER_PIN";
  if (pin !== null) {
    const info = run("docker.exe", ["info", "--format", "{{.OSType}}"]);
    if (info.error || info.status !== 0 || String(info.stdout).trim() !== "linux")
      image = "BLOCKED_DOCKER_LINUX";
    else {
      const context = run("docker.exe", [
        "context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}',
      ]);
      const endpoint = String(context.stdout).trim();
      if (context.error || context.status !== 0 ||
          !["npipe:////./pipe/dockerDesktopLinuxEngine", "npipe:////./pipe/docker_engine"].includes(endpoint))
        image = "BLOCKED_DOCKER_ENDPOINT";
      else {
        const id = run("docker.exe", ["image", "inspect", "--format", "{{.Id}}", "sha256:" + pin]);
        image = !id.error && id.status === 0 &&
          String(id.stdout).trim() === "sha256:" + pin
          ? "LOCAL_ID_MATCH_FORMAT_ONLY" : "NOT_INSTALLED_OR_ID_MISMATCH";
      }
    }
  }
  return { candidate: CANDIDATE, policy, finalObject, partialObject, image };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || process.argv[2] !== "--inspect")
      throw Error("EXACT_READONLY_INSPECT_REQUIRED");
    const result = inspectV2();
    console.log("P520_V2_CANDIDATE_SHA=" + result.candidate);
    console.log("P520_V2_CIPHER=" + result.finalObject);
    console.log("P520_V2_CIPHER_PARTIAL=" + result.partialObject);
    console.log("P520_V2_OWNER_IMAGE_POLICY=" + result.policy);
    console.log("P520_V2_LOCAL_PINNED_IMAGE=" + result.image);
    console.log("P520_V2_ARCHIVE_SHA_READBACK=NOT_EXECUTED");
    console.log("P520_V2_PHYSICAL_PG_UPLOADS_RESTORE=NOT_EXECUTED");
    console.log("P520_V2_INVENTORY=READ_ONLY_COMPLETE");
    console.log("PRODUCTION_APPROVAL=NOT_GRANTED");
  } catch (error) {
    const message = String(error?.message ?? "");
    const reason = /^[A-Z0-9_]{4,90}$/.test(message) ? message : "UNVERIFIED";
    console.log("P520_V2_INVENTORY=BLOCKED_" + reason);
    console.log("P520_V2_PHYSICAL_PG_UPLOADS_RESTORE=NOT_EXECUTED");
    console.log("PRODUCTION_APPROVAL=NOT_GRANTED");
    process.exitCode = 2;
  }
}
