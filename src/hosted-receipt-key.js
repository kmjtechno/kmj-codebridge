import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { resolveAgentGatewayCredential } from "./agent-gateway-credential.js";
import {
  privateWindowsReceiptPath,
  windowsReceiptPathStatus,
} from "./receipt-windows-custody.js";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
}

// An elevated Windows token may create a file owned by Administrators even
// inside a user-owned private directory. Normalize ONLY a newly created,
// empty file, never an existing signer or its directory. Recheck all ACLs.
function ensureNewWindowsReceiptCustody(filename, fd) {
  const sameEmptyFile = () => {
    const opened = fs.fstatSync(fd);
    const current = fs.lstatSync(filename);
    return (
      opened.isFile() &&
      current.isFile() &&
      !current.isSymbolicLink() &&
      opened.nlink === 1 &&
      current.nlink === 1 &&
      opened.size === 0 &&
      current.size === 0 &&
      opened.dev === current.dev &&
      opened.ino === current.ino
    );
  };
  if (!sameEmptyFile()) throw Error("HOSTED_RECEIPT_KEY_PATH_UNSAFE");
  let status = windowsReceiptPathStatus(filename);
  if (status === "OWNER_MISMATCH") {
    const env = {
      SystemRoot: "C:\\Windows",
      windir: "C:\\Windows",
    };
    const identity = spawnSync(
      "C:\\Windows\\System32\\whoami.exe",
      ["/user", "/fo", "csv", "/nh"],
      {
        env,
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 4096,
        windowsHide: true,
      },
    );
    const sid = identity.stdout?.match(/"(S-1-[0-9-]+)"\s*$/)?.[1];
    if (identity.status !== 0 || identity.error || identity.signal || !sid)
      throw Error("HOSTED_RECEIPT_KEY_OWNER_IDENTITY_FAILED");
    if (!sameEmptyFile()) throw Error("HOSTED_RECEIPT_KEY_PATH_UNSAFE");
    const changed = spawnSync(
      "C:\\Windows\\System32\\icacls.exe",
      [filename, "/setowner", "*" + sid],
      { env, timeout: 30000, windowsHide: true, stdio: "ignore" },
    );
    if (changed.status !== 0 || changed.error || changed.signal)
      throw Error("HOSTED_RECEIPT_KEY_OWNER_BIND_FAILED");
    status = windowsReceiptPathStatus(filename);
  }
  if (status !== "PRIVATE")
    throw Error("HOSTED_RECEIPT_KEY_ACL_UNSAFE:" + status);
  if (!sameEmptyFile()) throw Error("HOSTED_RECEIPT_KEY_PATH_UNSAFE");
}

// Creation only in an already private operator-controlled directory.
// Windows validates inherited custody before any private bytes are written.
export async function provisionReceiptKey(config, filename) {
  const windows = process.platform === "win32";
  if (!windows && process.getuid?.() === undefined)
    throw Error("HOSTED_RECEIPT_PROVISIONING_PLATFORM_UNSUPPORTED");
  if (!path.isAbsolute(filename))
    throw Error("HOSTED_RECEIPT_KEY_PATH_INVALID");
  const destination = path.resolve(filename);
  const parent = path.dirname(destination);
  const parentStat = fs.lstatSync(parent);
  if (
    path.relative(fs.realpathSync(parent), parent) !== "" ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    (windows
      ? !privateWindowsReceiptPath(parent, true)
      : parentStat.uid !== process.getuid() ||
        (parentStat.mode & 0o077) !== 0) ||
    (config.gatewayTokenFile &&
      path.relative(destination, config.gatewayTokenFile) === "") ||
    inside(path.resolve(config.stateDir), destination) ||
    config.projects.some((project) =>
      inside(fs.realpathSync(project.root), destination),
    )
  )
    throw Error("HOSTED_RECEIPT_KEY_PATH_UNSAFE");

  let created = false;
  if (!fs.existsSync(destination)) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const encoded = privateKey
      .export({ type: "pkcs8", format: "der" })
      .toString("base64");
    const fd = fs.openSync(destination, "wx", 0o600);
    try {
      if (windows) ensureNewWindowsReceiptCustody(destination, fd);
      fs.writeFileSync(fd, encoded + "\n");
      fs.fsyncSync(fd);
      created = true;
    } finally {
      fs.closeSync(fd);
    }
  }

  const stat = fs.lstatSync(destination);
  if (stat.nlink !== 1 || (windows && !privateWindowsReceiptPath(destination)))
    throw Error("HOSTED_RECEIPT_KEY_PATH_UNSAFE");
  const encoded = await resolveAgentGatewayCredential({
    ...config,
    token: undefined,
    gatewayTokenFile: destination,
  });
  const key = createPrivateKey({
    key: Buffer.from(encoded, "base64"),
    format: "der",
    type: "pkcs8",
  });
  if (key.asymmetricKeyType !== "ed25519")
    throw Error("HOSTED_RECEIPT_KEY_INVALID");
  const publicKey = createPublicKey(key).export({ format: "jwk" });
  return {
    created,
    device: config.id,
    tenant: config.tenant,
    publicKey: Buffer.from(publicKey.x, "base64url").toString("base64"),
    enrollment: "OWNER_PIN_REQUIRED",
  };
}
