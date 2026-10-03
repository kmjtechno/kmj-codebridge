import fs from "node:fs";
import path from "node:path";
import { createPrivateKey, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
import { releaseManifestSchema } from "../src/update.js";

const KID = /^[A-Za-z0-9._-]{1,64}$/;

function outsideRepository(file) {
  const root = fs.realpathSync(process.cwd());
  const real = fs.realpathSync(file);
  const relative = path.relative(root, real);
  return (
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  );
}

export function buildSignedReleaseManifest({
  runtimeManifest,
  archiveUrl,
  sequence,
  keyId,
  privateKeyPem,
  channel = "stable",
  publishedAt = new Date().toISOString(),
}) {
  if (
    !runtimeManifest ||
    runtimeManifest.product !== "KMJ CodeBridge" ||
    runtimeManifest.format !== "source-runtime" ||
    runtimeManifest.signed !== false ||
    typeof runtimeManifest.version !== "string" ||
    typeof runtimeManifest.revision !== "string" ||
    !/^[a-f0-9]{40}$/.test(runtimeManifest.revision) ||
    typeof runtimeManifest.archive !== "string" ||
    !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(runtimeManifest.archive) ||
    !Number.isSafeInteger(runtimeManifest.bytes) ||
    runtimeManifest.bytes < 1 ||
    typeof runtimeManifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(runtimeManifest.sha256)
  )
    throw Error("RUNTIME_MANIFEST_INVALID");

  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    !KID.test(keyId ?? "") ||
    !["stable", "beta"].includes(channel)
  )
    throw Error("UPDATE_SIGNING_INPUT_INVALID");

  let url;
  try {
    url = new URL(archiveUrl);
  } catch {
    throw Error("UPDATE_SIGNING_INPUT_INVALID");
  }
  if (path.posix.basename(url.pathname) !== runtimeManifest.archive)
    throw Error("UPDATE_ARCHIVE_URL_MISMATCH");

  const manifest = releaseManifestSchema.parse({
    schema: 1,
    product: "KMJ CodeBridge",
    channel,
    sequence,
    version: runtimeManifest.version,
    revision: runtimeManifest.revision,
    archive: url.href,
    sha256: runtimeManifest.sha256,
    bytes: runtimeManifest.bytes,
    nodeMajor: 24,
    publishedAt,
    keyId,
  });
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");

  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw Error("UPDATE_PRIVATE_KEY_INVALID");
  }
  if (key.asymmetricKeyType !== "ed25519")
    throw Error("UPDATE_PRIVATE_KEY_INVALID");

  const signature = sign(null, manifestBytes, key).toString("base64url");
  return { manifest, manifestBytes, signature };
}

export function signRuntimeManifest({
  runtimeManifestPath,
  archiveUrl,
  sequence,
  keyId,
  privateKeyPath,
  outDir,
  channel = "stable",
  publishedAt,
}) {
  if (!outsideRepository(privateKeyPath))
    throw Error("PRIVATE_KEY_MUST_BE_OUTSIDE_REPOSITORY");

  const runtimeManifest = JSON.parse(
    fs.readFileSync(runtimeManifestPath, "utf8"),
  );
  const privateKeyPem = fs.readFileSync(privateKeyPath, "utf8");
  const signed = buildSignedReleaseManifest({
    runtimeManifest,
    archiveUrl,
    sequence,
    keyId,
    privateKeyPem,
    channel,
    publishedAt,
  });

  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(outDir, "release-manifest.json");
  const signaturePath = path.join(outDir, "release-manifest.sig");
  if (fs.existsSync(manifestPath) || fs.existsSync(signaturePath))
    throw Error("OUTPUT_EXISTS");
  fs.writeFileSync(manifestPath, signed.manifestBytes, { mode: 0o644 });
  fs.writeFileSync(signaturePath, signed.signature + "\n", { mode: 0o644 });
  return { manifestPath, signaturePath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [
      runtimeManifestPath,
      archiveUrl,
      rawSequence,
      outDir = "dist/release",
    ] = process.argv.slice(2);
    const privateKeyPath = process.env.CODEBRIDGE_RELEASE_KEY_FILE;
    const keyId = process.env.CODEBRIDGE_RELEASE_KID;
    const channel = process.env.CODEBRIDGE_RELEASE_CHANNEL ?? "stable";
    const publishedAt = process.env.CODEBRIDGE_RELEASE_PUBLISHED_AT;
    if (
      !runtimeManifestPath ||
      !archiveUrl ||
      !rawSequence ||
      !privateKeyPath ||
      !keyId
    )
      throw Error("USAGE");

    const result = signRuntimeManifest({
      runtimeManifestPath,
      archiveUrl,
      sequence: Number(rawSequence),
      keyId,
      privateKeyPath,
      outDir,
      channel,
      publishedAt,
    });
    console.log(
      `Signed release manifest created: ${result.manifestPath} and ${result.signaturePath}`,
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
