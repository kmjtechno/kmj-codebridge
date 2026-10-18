import fs from "node:fs";
import path from "node:path";
import { verifyTokenFileAcl } from "./windows-supervisor.js";

const isInside = (root, candidate) => {
  const relative = path.relative(root, candidate);
  return (
    !relative ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative))
  );
};

/**
 * Resolve only the gateway's enrolled bearer token, without logging the
 * value or its filename. Existing inline-token configurations remain valid.
 * A new service identity must have its OWN operator-approved enrollment and
 * private file. This function never copies or alters an existing token.
 */
export async function resolveAgentGatewayCredential(
  config,
  { platform = process.platform, validateWindowsAcl = verifyTokenFileAcl } = {},
) {
  const inline = typeof config.token === "string";
  const external = typeof config.gatewayTokenFile === "string";
  if (inline === external)
    throw Error("AGENT_GATEWAY_CREDENTIAL_SOURCE_INVALID");
  if (inline) return config.token;

  const name = config.gatewayTokenFile;
  if (!path.isAbsolute(name))
    throw Error("AGENT_GATEWAY_CREDENTIAL_PATH_NOT_ABSOLUTE");

  try {
    const resolved = fs.realpathSync(name);
    const expected = path.resolve(name);
    const canonical = (value) =>
      platform === "win32" ? value.toLowerCase() : value;
    if (
      canonical(path.normalize(resolved)) !==
      canonical(path.normalize(expected))
    )
      throw Error("AGENT_GATEWAY_CREDENTIAL_PATH_ALIAS");

    for (const project of config.projects ?? []) {
      if (isInside(fs.realpathSync(project.root), resolved))
        throw Error("AGENT_GATEWAY_CREDENTIAL_INSIDE_PROJECT");
    }
    if (isInside(path.resolve(config.stateDir), resolved))
      throw Error("AGENT_GATEWAY_CREDENTIAL_INSIDE_STATE");

    const stat = fs.lstatSync(name);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size < 32 ||
      stat.size > 4098
    )
      throw Error("AGENT_GATEWAY_CREDENTIAL_UNSAFE_FILE");
    if (platform === "win32") {
      const acl = await validateWindowsAcl(name);
      if (!acl?.ok) throw Error("AGENT_GATEWAY_CREDENTIAL_ACL_REJECTED");
    } else {
      if ((stat.mode & 0o077) !== 0)
        throw Error("AGENT_GATEWAY_CREDENTIAL_PERMISSIONS");
      if (process.getuid?.() !== undefined && stat.uid !== process.getuid())
        throw Error("AGENT_GATEWAY_CREDENTIAL_OWNER");
    }

    const fd = fs.openSync(
      name,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
    );
    try {
      const current = fs.fstatSync(fd);
      if (
        !current.isFile() ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.size < 32 ||
        current.size > 4098
      )
        throw Error("AGENT_GATEWAY_CREDENTIAL_CHANGED");
      const raw = fs.readFileSync(fd, "utf8");
      const credential = raw.replace(/\r?\n$/, "");
      if (
        credential.length < 32 ||
        credential.length > 4096 ||
        !/^[\x21-\x7e]+$/.test(credential)
      )
        throw Error("AGENT_GATEWAY_CREDENTIAL_FORMAT");
      return credential;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Never include the private filename, ACL entries, token or OS error.
    throw Error("AGENT_GATEWAY_CREDENTIAL_FILE_UNSAFE");
  }
}
