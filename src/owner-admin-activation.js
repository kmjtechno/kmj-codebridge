import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentSchema } from "./config.js";
import { requestRenewal } from "./renewal.js";
import { fail } from "./errors.js";

export const OWNER_ADMIN_RENEWAL_URL =
  "https://kmjtechno.com/api/v1/codebridge/renew";

function readFileSafe(file, { privateFile = false, maxBytes = 65536 } = {}) {
  const meta = fs.lstatSync(file);
  if (!meta.isFile() || meta.nlink !== 1 || meta.size > maxBytes)
    fail("OWNER_ADMIN_INVALID_FILE");
  if (privateFile && (meta.mode & 0o077) !== 0)
    fail("OWNER_ADMIN_INSECURE_PERMISSIONS");
  const fd = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes)
      fail("OWNER_ADMIN_INVALID_FILE");
    return fs.readFileSync(fd, "utf8").trim();
  } finally {
    fs.closeSync(fd);
  }
}

function writeExclusive(file, content) {
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      (fs.constants.O_NOFOLLOW || 0),
    0o600,
  );
  try {
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function activateOwnerAdmin(
  { configPath, publicKeysPath, credentialPath },
  options = {},
) {
  if (process.platform === "win32") fail("OWNER_ADMIN_ACL_VERIFICATION_UNAVAILABLE");
  if (![configPath, publicKeysPath, credentialPath].every(
    (value) => typeof value === "string" && path.isAbsolute(value),
  ))
    fail("OWNER_ADMIN_ABSOLUTE_PATH_REQUIRED");

  const configText = readFileSafe(configPath, { privateFile: true });
  const config = JSON.parse(configText);
  agentSchema.parse(config);
  if (config.license.mode !== "free") fail("OWNER_ADMIN_ALREADY_SIGNED");

  const keys = JSON.parse(readFileSafe(publicKeysPath));
  if (!keys || typeof keys !== "object" || Array.isArray(keys))
    fail("OWNER_ADMIN_INVALID_PUBLIC_KEYS");
  for (const value of Object.values(keys)) {
    if (
      typeof value !== "string" ||
      !value.includes("BEGIN PUBLIC KEY") ||
      value.includes("PRIVATE KEY")
    )
      fail("OWNER_ADMIN_INVALID_PUBLIC_KEYS");
  }
  const credential = readFileSafe(credentialPath, {
    privateFile: true,
    maxBytes: 4096,
  });
  if (credential.length < 32) fail("OWNER_ADMIN_INVALID_CREDENTIAL");

  const stateDir = fs.realpathSync(config.stateDir);
  const stateMeta = fs.statSync(stateDir);
  const configMeta = fs.statSync(configPath);
  if (!stateMeta.isDirectory() || stateMeta.uid !== configMeta.uid)
    fail("OWNER_ADMIN_STATE_DIR_OWNER_MISMATCH");
  const leasePath = path.join(stateDir, "owner-admin-entitlement.jws");
  const backupPath = configPath + ".before-owner-admin.bak";
  if (fs.existsSync(leasePath) || fs.existsSync(backupPath))
    fail("OWNER_ADMIN_EXISTING_ACTIVATION");
  for (const project of config.projects) {
    const root = fs.realpathSync(project.root);
    const rel = path.relative(root, leasePath);
    if (!rel || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel)))
      fail("OWNER_ADMIN_LEASE_INSIDE_PROJECT");
  }

  const renewal = {
    endpoint: OWNER_ADMIN_RENEWAL_URL,
    credential,
    intervalSeconds: 3600,
  };
  const updated = {
    ...config,
    license: { mode: "signed", tokenFile: leasePath, keys, renewal },
  };
  agentSchema.parse(updated);

  // Authenticated device renewal, signature and device/tenant binding are
  // mandatory before touching any on-disk state. No fabricated local grant.
  const { token, claims } = await requestRenewal(
    renewal,
    keys,
    { tenant: config.tenant, device: config.id },
    -1,
    { fetch: options.fetch, now: options.now },
  );
  if (
    claims.limits.concurrent_jobs !== 16 ||
    claims.limits.devices !== 2147483647 ||
    !["read", "write", "execute"].every((f) => claims.features.includes(f))
  )
    fail("OWNER_ADMIN_SIGNED_PLAN_NOT_ACTIVE");

  const dir = path.dirname(configPath);
  const temp = configPath + ".signed-" + randomUUID() + ".tmp";
  let leaseWritten = false;
  let configCommitted = false;
  try {
    writeExclusive(backupPath, configText + "\n");
    writeExclusive(leasePath, token + "\n");
    leaseWritten = true;
    syncDirectory(stateDir);
    writeExclusive(temp, JSON.stringify(updated, null, 2) + "\n");
    fs.renameSync(temp, configPath);
    configCommitted = true;
    syncDirectory(dir);
  } catch (error) {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
    if (leaseWritten && !configCommitted) fs.unlinkSync(leasePath);
    throw error;
  }

  return {
    activated: true,
    device: config.id,
    tenant: config.tenant,
    signedConcurrentJobs: claims.limits.concurrent_jobs,
    restartRequired: true,
    backupPath,
  };
}
