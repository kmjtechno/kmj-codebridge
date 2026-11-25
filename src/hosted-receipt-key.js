import fs from "node:fs";
import path from "node:path";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { resolveAgentGatewayCredential } from "./agent-gateway-credential.js";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
}

// POSIX-only creation in an already private operator-controlled directory.
// Windows requires a separately reviewed atomic private DACL creation path.
export async function provisionReceiptKey(config, filename) {
  if (process.platform === "win32" || process.getuid?.() === undefined)
    throw Error("HOSTED_RECEIPT_PROVISIONING_PLATFORM_UNSUPPORTED");
  if (!path.isAbsolute(filename))
    throw Error("HOSTED_RECEIPT_KEY_PATH_INVALID");
  const destination = path.resolve(filename);
  const parent = path.dirname(destination);
  const parentStat = fs.lstatSync(parent);
  if (
    fs.realpathSync(parent) !== parent ||
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.getuid() ||
    (parentStat.mode & 0o077) !== 0 ||
    destination === config.gatewayTokenFile ||
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
      fs.writeFileSync(fd, encoded + "\n");
      fs.fsyncSync(fd);
      created = true;
    } finally {
      fs.closeSync(fd);
    }
  }

  const stat = fs.lstatSync(destination);
  if (stat.nlink !== 1) throw Error("HOSTED_RECEIPT_KEY_PATH_UNSAFE");
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
