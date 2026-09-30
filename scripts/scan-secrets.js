// Distribution gate: fail if tracked files or built packages contain likely
// credentials or private configuration. Usage:
//   node scripts/scan-secrets.js            scan git-tracked files
//   node scripts/scan-secrets.js dist ...   also scan the given directories
// Findings print file and line only, never the matched value.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const patterns = [
  ["private key", /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ["bearer credential", /Bearer\s+(?!\$\{)[A-Za-z0-9._~+/-]{24,}={0,2}/],
  ["Anthropic/OpenAI key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_\w{40,})/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{20,}/],
];
const privateNames =
  /(?:^|\/)(?:\.env(?:\..+)?|client-token\.txt|agent\.json|gateway\.json|[^/]*\.(?:pem|key|p12|pfx))$/;
const skipNames =
  /(?:^|\/)package-lock\.json$|\.(?:tar\.gz|tgz|zip|png|jpg|webp|ico)$/;

export function scanFile(file, display = file) {
  const findings = [];
  if (privateNames.test(display.split(path.sep).join("/")))
    findings.push(`${display}: private configuration file`);
  if (skipNames.test(display)) return findings;
  const buf = fs.readFileSync(file);
  if (buf.includes(0)) return findings;
  buf
    .toString("utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      for (const [label, re] of patterns)
        if (re.test(line)) findings.push(`${display}:${i + 1}: ${label}`);
    });
  return findings;
}

export function scanDirectory(dir) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .flatMap((e) => {
      const file = path.join(e.parentPath ?? e.path, e.name);
      return scanFile(file, path.relative(process.cwd(), file) || file);
    });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .filter((f) => fs.existsSync(f));
  const findings = tracked.flatMap((f) => scanFile(f));
  for (const dir of process.argv.slice(2)) findings.push(...scanDirectory(dir));
  if (findings.length) {
    console.error(findings.join("\n"));
    console.error(`${findings.length} possible credential finding(s).`);
    process.exitCode = 1;
  } else {
    console.log(
      `No credentials found in ${tracked.length} tracked file(s)` +
        (process.argv.length > 2
          ? ` and ${process.argv.slice(2).join(", ")}`
          : "") +
        ".",
    );
  }
}
