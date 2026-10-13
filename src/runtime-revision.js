import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Which source revision this process actually runs. The P720 updater runs the
// agent from a detached `codebridge-releases/<sha>` worktree while leaving the
// project checkout untouched, so the project's `git log` cannot answer this.
// Bounded file reads only: no git process, no network, and anything malformed
// is reported as unknown rather than guessed.
const SHA = /^[a-f0-9]{40}$/;
const REF = /^refs\/heads\/[A-Za-z0-9._\/-]{1,200}$/;
const MAX_BYTES = 4096;
const DEFAULT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readSmall(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("UNTRUSTED");
  return fs.readFileSync(file, "utf8");
}

function gitDirOf(root) {
  const dotGit = path.join(root, ".git");
  const stat = fs.lstatSync(dotGit);
  if (stat.isDirectory()) return { gitDir: dotGit, commonDir: dotGit };
  // A linked worktree's `.git` file points at <common>/worktrees/<name>.
  const match = /^gitdir: (.+)$/.exec(readSmall(dotGit).trim());
  if (!match) throw new Error("UNTRUSTED");
  const gitDir = path.resolve(root, match[1]);
  let commonDir = gitDir;
  try {
    commonDir = path.resolve(
      gitDir,
      readSmall(path.join(gitDir, "commondir")).trim(),
    );
  } catch {}
  return { gitDir, commonDir };
}

function resolveRef(commonDir, gitDir, ref) {
  for (const dir of [gitDir, commonDir]) {
    try {
      const value = readSmall(path.join(dir, ref)).trim();
      if (SHA.test(value)) return value;
    } catch {}
  }
  const packedFile = path.join(commonDir, "packed-refs");
  const stat = fs.lstatSync(packedFile);
  // packed-refs can be large; bound it separately and parse line by line.
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return null;
  for (const line of fs.readFileSync(packedFile, "utf8").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && SHA.test(sha)) return sha;
  }
  return null;
}

export function runtimeRevision(root = DEFAULT_ROOT) {
  try {
    const marker = JSON.parse(
      readSmall(path.join(root, ".codebridge-release.json")),
    );
    if (marker?.schema === 1 && SHA.test(marker.revision))
      return { commit: marker.revision, source: "release-marker" };
  } catch {}
  try {
    const { gitDir, commonDir } = gitDirOf(root);
    const head = readSmall(path.join(gitDir, "HEAD")).trim();
    if (SHA.test(head)) return { commit: head, source: "git-detached" };
    const ref = /^ref: (.+)$/.exec(head)?.[1];
    if (ref && REF.test(ref) && !ref.split("/").includes("..")) {
      const commit = resolveRef(commonDir, gitDir, ref);
      if (commit) return { commit, source: "git-branch" };
    }
  } catch {}
  return null;
}
