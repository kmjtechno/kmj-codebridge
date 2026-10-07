import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function buildReleaseCandidateMetadata({ product, runtime }) {
  if (
    product?.product?.name !== "KMJ CodeBridge" ||
    product?.versions?.stable !== runtime?.version ||
    runtime?.product !== "KMJ CodeBridge" ||
    runtime?.format !== "source-runtime" ||
    runtime?.signed !== false ||
    !REVISION.test(runtime?.revision ?? "") ||
    !SHA256.test(runtime?.sha256 ?? "") ||
    !Number.isSafeInteger(runtime?.bytes) ||
    runtime.bytes < 1 ||
    typeof runtime?.archive !== "string" ||
    !/^[A-Za-z0-9._-]+\.tar\.gz$/.test(runtime.archive)
  )
    throw Error("RELEASE_METADATA_INPUT_INVALID");

  const compatibility = {
    schema: 1,
    product: "KMJ CodeBridge",
    version: runtime.version,
    revision: runtime.revision,
    nodeMajor: 24,
    minimumAgent: product.versions.minimumAgent,
    minimumClientPackage: product.versions.minimumClientPackage,
    supportedClients: [...product.supportedClients],
    updateChannels: [...product.updateChannels],
  };
  const signingRequest = {
    schema: 1,
    product: "KMJ CodeBridge",
    version: runtime.version,
    revision: runtime.revision,
    channel: "stable",
    state: "owner_signing_required",
    runtimeManifest: "runtime/manifest.json",
    archive: `runtime/${runtime.archive}`,
    sha256: runtime.sha256,
    bytes: runtime.bytes,
    requiredPrivateInputs: [
      "CODEBRIDGE_RELEASE_KEY_FILE",
      "CODEBRIDGE_RELEASE_KID",
      "monotonic release sequence",
      "final public HTTPS archive URL",
    ],
    policy:
      "Do not publish an official stable release until an owner-controlled Ed25519 key outside the repository signs the exact release manifest and live activation/rollback evidence is captured.",
  };
  const checksums = `${runtime.sha256}  runtime/${runtime.archive}\n`;
  const releaseNotes = [
    `# KMJ CodeBridge ${runtime.version} release candidate`,
    "",
    `Source revision: \`${runtime.revision}\``,
    "",
    "This bundle is a release candidate, not an official signed stable release.",
    "It includes the runtime archive, client packages, CycloneDX SBOM, provenance/attestation evidence when produced by main-branch CI, compatibility metadata, and credential-scan evidence.",
    "",
    "## Publication gate",
    "",
    "Official stable publication requires an owner-controlled Ed25519 signing key kept outside the repository, a monotonically increasing release sequence, a final public HTTPS archive URL, and observed live activation plus failed-health rollback evidence.",
    "",
  ].join("\n");

  return { compatibility, signingRequest, checksums, releaseNotes };
}

export function writeReleaseCandidateMetadata({ productPath, runtimePath, outDir }) {
  const product = JSON.parse(fs.readFileSync(productPath, "utf8"));
  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
  const built = buildReleaseCandidateMetadata({ product, runtime });
  fs.mkdirSync(outDir, { recursive: true });
  const outputs = {
    compatibility: path.join(outDir, "compatibility.json"),
    signingRequest: path.join(outDir, "signing-request.json"),
    checksums: path.join(outDir, "checksums.txt"),
    releaseNotes: path.join(outDir, "RELEASE-NOTES.md"),
  };
  for (const file of Object.values(outputs))
    if (fs.existsSync(file)) throw Error("OUTPUT_EXISTS");
  fs.writeFileSync(outputs.compatibility, JSON.stringify(built.compatibility, null, 2) + "\n");
  fs.writeFileSync(outputs.signingRequest, JSON.stringify(built.signingRequest, null, 2) + "\n");
  fs.writeFileSync(outputs.checksums, built.checksums);
  fs.writeFileSync(outputs.releaseNotes, built.releaseNotes);
  return outputs;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    const [runtimePath, outDir] = process.argv.slice(2);
    if (!runtimePath || !outDir) throw Error("USAGE");
    writeReleaseCandidateMetadata({
      productPath: "product/codebridge-product.json",
      runtimePath,
      outDir,
    });
  } catch (error) {
    console.error(
      ["RELEASE_METADATA_INPUT_INVALID", "OUTPUT_EXISTS", "USAGE"].includes(
        error.message,
      )
        ? error.message
        : "RELEASE_METADATA_FAILED",
    );
    process.exitCode = 1;
  }
}
