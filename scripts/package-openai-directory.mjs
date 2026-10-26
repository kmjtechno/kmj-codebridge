// Create a separate OpenAI public-directory review ZIP without changing the
// private desktop plugin. A package is NOT a submission, approval or release.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const DIRECTORY_MCP_URL = "https://kmjtechno.com/mcp";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "plugin");

function copyApproved(sourceRelativePath, targetRoot) {
  const source = path.join(SOURCE, sourceRelativePath);
  const target = path.join(targetRoot, sourceRelativePath);
  if (!fs.existsSync(source))
    throw Error("MISSING_PUBLIC_PACKAGE_ASSET: " + sourceRelativePath);
  // Never package links to files outside the repository or private credentials.
  fs.cpSync(source, target, {
    recursive: true,
    force: false,
    errorOnExist: true,
    filter: (candidate) => {
      if (fs.lstatSync(candidate).isSymbolicLink())
        throw Error("PUBLIC_PACKAGE_SYMLINK_BLOCKED");
      return true;
    },
  });
}

function validateManifest(manifest) {
  const ext = manifest.extensions?.["com.openai"];
  const ui = ext?.interface;
  if (
    manifest.name !== "kmj-codebridge" ||
    manifest.author?.name !== "KMJ TECHNO"
  )
    throw Error("PUBLIC_PACKAGE_IDENTITY_MISMATCH");
  if (!ui || ui.developerName !== "KMJ TECHNO")
    throw Error("PUBLIC_PACKAGE_LISTING_INVALID");
  for (const field of [
    "websiteURL",
    "supportURL",
    "privacyPolicyURL",
    "termsOfServiceURL",
  ]) {
    const url = new URL(ui[field]);
    if (url.protocol !== "https:" || url.username || url.password)
      throw Error("PUBLIC_PACKAGE_LINK_INVALID: " + field);
  }
  const cases = ext.review?.test_cases;
  if (cases?.positive?.length !== 5 || cases?.negative?.length !== 3)
    throw Error("PUBLIC_PACKAGE_REVIEW_CASES_INVALID");
  if (ext.apps || manifest.apps || manifest.hooks || ext.hooks)
    throw Error("PUBLIC_PACKAGE_APP_OR_HOOK_BLOCKED");
  for (const key of ["logo", "logoDark", "composerIcon", "composerIconDark"]) {
    const relative = ui[key]?.replace(/^\.\//, "");
    if (!relative || !/^assets\/[A-Za-z0-9_.-]+$/.test(relative))
      throw Error("PUBLIC_PACKAGE_ICON_INVALID");
    if (!fs.existsSync(path.join(SOURCE, relative)))
      throw Error("PUBLIC_PACKAGE_ICON_MISSING");
  }
}

export function buildOpenAIDirectoryCandidate({ outBase, zip = true } = {}) {
  if (typeof outBase !== "string" || !outBase.trim())
    throw Error("PUBLIC_PACKAGE_OUTPUT_REQUIRED");
  const base = path.resolve(outBase);
  if (base === SOURCE || base.startsWith(SOURCE + path.sep))
    throw Error("PUBLIC_PACKAGE_SOURCE_OVERWRITE_BLOCKED");
  const directory = path.join(base, "kmj-codebridge");
  const archive = path.join(base, "kmj-codebridge-openai-directory.zip");
  if (fs.existsSync(directory) || fs.existsSync(archive))
    throw Error("PUBLIC_PACKAGE_DESTINATION_EXISTS");
  const manifest = JSON.parse(
    fs.readFileSync(path.join(SOURCE, "plugin.json"), "utf8"),
  );
  // The local App binding belongs to an installed private integration. Public
  // submissions cannot contain apps/.app.json or desktop-only stdio servers.
  delete manifest.apps;
  delete manifest.extensions?.["com.openai"]?.apps;
  delete manifest.hooks;
  if (manifest.extensions?.["com.openai"]) {
    delete manifest.extensions["com.openai"].hooks;
  }
  validateManifest(manifest);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const item of ["LICENSE", "PRIVACY.md", "TERMS.md", "assets", "skills"])
    copyApproved(item, directory);
  fs.writeFileSync(
    path.join(directory, "plugin.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const mcp = {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      codebridge: { type: "streamable-http", url: DIRECTORY_MCP_URL },
    },
  };
  fs.writeFileSync(
    path.join(directory, "mcp.json"),
    JSON.stringify(mcp, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  if (zip) {
    // Fixed arguments, no shell and no arbitrary URL. CI uses the stock zip
    // binary. Keep a single top-level plugin directory inside the archive.
    execFileSync("zip", ["-q", "-X", "-r", archive, "kmj-codebridge"], {
      cwd: base,
      stdio: "pipe",
    });
  }
  const sha256 = zip
    ? createHash("sha256").update(fs.readFileSync(archive)).digest("hex")
    : null;
  return { directory, archive: zip ? archive : null, sha256 };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--out")
      throw Error(
        "Usage: node scripts/package-openai-directory.mjs --out OUTPUT_DIRECTORY",
      );
    const result = buildOpenAIDirectoryCandidate({ outBase: args[1] });
    console.log("PUBLIC_DIRECTORY_ZIP=" + result.archive);
    console.log("PUBLIC_DIRECTORY_SHA256=" + result.sha256);
    console.log("PUBLIC_DIRECTORY_STATUS=REVIEW_CANDIDATE_NOT_SUBMITTED");
    console.log(
      "PUBLIC_DIRECTORY_GATES=LIVE_MCP_SECURITY_REVIEW_AND_PUBLISHER_VERIFICATION_REQUIRED",
    );
  } catch (error) {
    console.error("PUBLIC_DIRECTORY_PACKAGE_FAIL=" + error.message);
    process.exitCode = 1;
  }
}
