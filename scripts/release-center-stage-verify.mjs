#!/usr/bin/env node
// Read-only isolated source-stage receipt. Not a signature or deployed runtime.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const ARCHIVE = /^kmj-codebridge-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?-[a-f0-9]{12}\.tar\.gz$/;
const MAX_ARCHIVE = 512 * 1024 * 1024;

export function assessStagedRuntime(manifest, revision, data) {
  const fail = (reason) => ({ ready: false, reason });
  if (typeof revision !== "string" || !SHA.test(revision))
    return fail("STAGE_REVISION_INVALID");
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return fail("STAGE_MANIFEST_INVALID");
  if (
    manifest.product !== "KMJ CodeBridge" ||
    manifest.revision !== revision ||
    manifest.format !== "source-runtime" ||
    manifest.signed !== false ||
    typeof manifest.version !== "string" ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)
  ) return fail("STAGE_SOURCE_OR_SIGNING_MISMATCH");
  if (
    typeof manifest.archive !== "string" ||
    !ARCHIVE.test(manifest.archive) ||
    !manifest.archive.endsWith("-" + revision.slice(0, 12) + ".tar.gz") ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 1 || manifest.bytes > MAX_ARCHIVE ||
    typeof manifest.sha256 !== "string" || !DIGEST.test(manifest.sha256)
  ) return fail("STAGE_ARCHIVE_METADATA_INVALID");
  if (!Buffer.isBuffer(data) || data.length !== manifest.bytes)
    return fail("STAGE_ARCHIVE_LENGTH_MISMATCH");
  const sha256 = createHash("sha256").update(data).digest("hex");
  if (sha256 !== manifest.sha256)
    return fail("STAGE_ARCHIVE_HASH_MISMATCH");
  return {
    ready: true,
    state: "STAGED_SOURCE_ONLY_OWNER_SIGNATURE_REQUIRED",
    revision,
    version: manifest.version,
    sha256,
    bytes: data.length,
    signed: false,
    productionMutation: "NONE",
  };
}

export function verifyStagedRuntime(manifestPath, revision) {
  if (typeof manifestPath !== "string" || !manifestPath.endsWith("/manifest.json"))
    throw Error("STAGE_MANIFEST_PATH_INVALID");
  if (!SHA.test(revision ?? "")) throw Error("STAGE_REVISION_INVALID");
  const stat = fs.lstatSync(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 8192)
    throw Error("STAGE_MANIFEST_UNSAFE");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (typeof manifest?.archive !== "string" || !ARCHIVE.test(manifest.archive))
    throw Error("STAGE_ARCHIVE_METADATA_INVALID");
  const filename = path.join(path.dirname(manifestPath), manifest.archive);
  const archiveStat = fs.lstatSync(filename);
  if (!archiveStat.isFile() || archiveStat.isSymbolicLink() ||
      archiveStat.nlink !== 1 || archiveStat.size < 1 ||
      archiveStat.size > MAX_ARCHIVE)
    throw Error("STAGE_ARCHIVE_UNSAFE");
  const result = assessStagedRuntime(manifest, revision, fs.readFileSync(filename));
  if (!result.ready) throw Error(result.reason);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 5)
      throw Error("STAGE_ARGUMENT_COUNT_INVALID");
    const report = verifyStagedRuntime(process.argv[2], process.argv[3]);
    const output = process.argv[4];
    if (typeof output !== "string" || !output.endsWith("/stage-receipt.json"))
      throw Error("STAGE_RECEIPT_PATH_INVALID");
    fs.writeFileSync(output, JSON.stringify({
      schema: "kmj.codebridge.stage.v1", ...report
    }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log("CODEBRIDGE_STAGE=" + report.state);
    console.log("CODEBRIDGE_STAGE_SHA=" + report.revision);
    console.log("CODEBRIDGE_PRODUCTION_MUTATION=NONE");
  } catch (error) {
    const code = String(error?.message ?? "");
    console.error("CODEBRIDGE_STAGE=BLOCKED:" +
      (/^[A-Z_]{6,64}$/.test(code) ? code : "STAGE_VERIFICATION_FAILED"));
    process.exitCode = 2;
  }
}
