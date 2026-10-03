import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parseUpdateManifest } from "../src/update-manifest.js";

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const KID = /^[A-Za-z0-9._:-]{1,128}$/;

function fail(message) {
  throw Error(message);
}

function safeOutput(outDir, name) {
  const target = path.join(outDir, name);
  if (fs.existsSync(target)) fail("OUTPUT_EXISTS");
  return target;
}

export function buildSignedUpdateManifest({
  runtimeManifest,
  archiveUrl,
  sequence,
  kid,
  privateKeyPem,
  channel = "stable",
}) {
  if (
    !runtimeManifest ||
    runtimeManifest.product !== "KMJ CodeBridge" ||
    runtimeManifest.format !== "source-runtime" ||
    runtimeManifest.signed !== false ||
    typeof runtimeManifest.version !== "string" ||
    !SEMVER.test(runtimeManifest.version) ||
    typeof runtimeManifest.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(runtimeManifest.revision) ||
    typeof runtimeManifest.archive !== "string" ||
    !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(runtimeManifest.archive) ||
    !Number.isSafeInteger(runtimeManifest.bytes) ||
    runtimeManifest.bytes < 1 ||
    typeof runtimeManifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(runtimeManifest.sha256)
  )
    fail("RUNTIME_MANIFEST_INVALID");
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !KID.test(kid ?? "") ||
    !["stable", "beta"].includes(channel)
  )
    fail("UPDATE_SIGNING_INPUT_INVALID");

  let url;
  try {
    url = new URL(archiveUrl);
  } catch {
    fail("UPDATE_SIGNING_INPUT_INVALID");
  }
  if (path.posix.basename(url.pathname) !== runtimeManifest.archive)
    fail("UPDATE_ARCHIVE_URL_MISMATCH");

  const manifest = {
    v: 1,
    product: "KMJ_CODEBRIDGE",
    channel,
    sequence,
    version: runtimeManifest.version,
    revision: runtimeManifest.revision,
    format: "source-runtime",
    nodeMajor: 24,
    archiveUrl: url.href,
    archiveBytes: runtimeManifest.bytes,
    archiveSha256: runtimeManifest.sha256,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  parseUpdateManifest(manifestBytes);

  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    fail("UPDATE_PRIVATE_KEY_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519")
    fail("UPDATE_PRIVATE_KEY_INVALID");

  const signature = {
    v: 1,
    alg: "EdDSA",
    kid,
    sig: sign(null, manifestBytes, key).toString("base64url"),
  };
  return {
    manifestBytes,
    signatureBytes: Buffer.from(JSON.stringify(signature, null, 2) + "\n"),
  };
}

export function signRuntimeManifest({
  runtimeManifestPath,
  archiveUrl,
  sequence,
  kid,
  privateKeyPath,
  outDir,
  channel = "stable",
}) {
  const cwd = fs.realpathSync(process.cwd());
  const keyFile = fs.realpathSync(privateKeyPath);
  const relative = path.relative(cwd, keyFile);
  if (
    !relative ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  )
    fail("PRIVATE_KEY_MUST_BE_OUTSIDE_REPOSITORY");

  const runtimeManifest = JSON.parse(
    fs.readFileSync(runtimeManifestPath, "utf8"),
  );
  const privateKeyPem = fs.readFileSync(keyFile, "utf8");
  const signed = buildSignedUpdateManifest({
    runtimeManifest,
    archiveUrl,
    sequence,
    kid,
    privateKeyPem,
    channel,
  });

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifestPath = safeOutput(outDir, "update-manifest.json");
  const signaturePath = safeOutput(outDir, "update-manifest.sig.json");
  fs.writeFileSync(manifestPath, signed.manifestBytes, { mode: 0o644 });
  fs.writeFileSync(signaturePath, signed.signatureBytes, { mode: 0o644 });
  return { manifestPath, signaturePath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [runtimeManifestPath, archiveUrl, rawSequence, outDir = "dist/release"] =
      process.argv.slice(2);
    const privateKeyPath = process.env.CODEBRIDGE_RELEASE_KEY_FILE;
    const kid = process.env.CODEBRIDGE_RELEASE_KID;
    const channel = process.env.CODEBRIDGE_RELEASE_CHANNEL ?? "stable";
    if (
      !runtimeManifestPath ||
      !archiveUrl ||
      !rawSequence ||
      !privateKeyPath ||
      !kid
    )
      fail("USAGE");
    const sequence = Number(rawSequence);
    const result = signRuntimeManifest({
      runtimeManifestPath,
      archiveUrl,
      sequence,
      kid,
      privateKeyPath,
      outDir,
      channel,
    });
    console.log(
      `Signed update manifest created: ${result.manifestPath} and ${result.signaturePath}`,
    );
  } catch (error) {
    console.error(
      [
        "OUTPUT_EXISTS",
        "PRIVATE_KEY_MUST_BE_OUTSIDE_REPOSITORY",
        "RUNTIME_MANIFEST_INVALID",
        "UPDATE_SIGNING_INPUT_INVALID",
        "UPDATE_ARCHIVE_URL_MISMATCH",
        "UPDATE_PRIVATE_KEY_INVALID",
        "USAGE",
      ].includes(error.message)
        ? error.message
        : "UPDATE_MANIFEST_SIGNING_FAILED",
    );
    process.exitCode = 1;
  }
}
