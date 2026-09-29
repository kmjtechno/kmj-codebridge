import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
export function packageRuntime(root, out) {
  root = path.resolve(root);
  out = path.resolve(out);
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (git(["status", "--porcelain", "--untracked-files=no"]))
    throw Error("DIRTY_SOURCE");
  const revision = git(["rev-parse", "HEAD"]);
  const entries = execFileSync(
    "git",
    ["ls-tree", "-rz", "--name-only", "HEAD"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
    .split("\0")
    .filter(Boolean);
  if (
    entries.some((name) =>
      /(^|\/)(\.env($|\.)|\.ssh\/|\.aws\/|credentials($|\.)|agent\.json$|gateway\.json$|client-token\.txt$)|\.(pem|key|p12|pfx|jws)$/i.test(
        name,
      ),
    )
  )
    throw Error("UNSAFE_TRACKED_PATH");
  const pkg = JSON.parse(git(["show", "HEAD:package.json"]));
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version))
    throw Error("INVALID_VERSION");
  if (fs.existsSync(out)) throw Error("OUTPUT_EXISTS");
  fs.mkdirSync(out, { recursive: true });
  const name = `kmj-codebridge-${pkg.version}-${revision.slice(0, 12)}`;
  const archive = path.join(out, name + ".tar.gz");
  git([
    "archive",
    "--format=tar.gz",
    `--prefix=${name}/`,
    `--output=${archive}`,
    revision,
  ]);
  const data = fs.readFileSync(archive);
  const sha256 = createHash("sha256").update(data).digest("hex");
  const manifest = path.join(out, "manifest.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        product: "KMJ CodeBridge",
        version: pkg.version,
        revision,
        archive: path.basename(archive),
        bytes: data.length,
        sha256,
        format: "source-runtime",
        requires: "Node.js 24; npm ci --ignore-scripts",
        signed: false,
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(
    path.join(out, "SHA256SUMS"),
    `${sha256}  ${path.basename(archive)}\n`,
  );
  return { archive, manifest };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    packageRuntime(process.cwd(), process.argv[2] ?? "dist/runtime");
    console.log(
      "Runtime source archive and SHA256 manifest created. No installer signature is claimed.",
    );
  } catch (error) {
    console.error(
      [
        "DIRTY_SOURCE",
        "UNSAFE_TRACKED_PATH",
        "INVALID_VERSION",
        "OUTPUT_EXISTS",
      ].includes(error.message)
        ? error.message
        : "RUNTIME_PACKAGE_FAILED",
    );
    process.exitCode = 1;
  }
}
