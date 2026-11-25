import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { planTerminalWorkspaceSnapshot } from "./terminal-workspace-snapshot.js";

const SHA256 = /^[a-f0-9]{64}$/;

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function privateRoot(root) {
  if (
    process.platform !== "linux" ||
    typeof root !== "string" ||
    !path.isAbsolute(root)
  )
    throw new Error("TERMINAL_STAGE_PRIVATE_STORAGE_UNVERIFIED");
  const canonical = path.resolve(root);
  const st = fs.lstatSync(canonical);
  if (
    !st.isDirectory() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    (st.mode & 0o077) !== 0 ||
    fs.realpathSync(canonical) !== canonical
  )
    throw new Error("TERMINAL_STAGE_PRIVATE_STORAGE_UNVERIFIED");
  return canonical;
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(".." + path.sep))
  );
}

// Local staging only. The caller supplies the trusted isolated-lane
// ProjectFiles and HEAD reader, not a caller-selected project root.
export function stageTerminalWorkspace({
  files,
  readHead,
  expectedHead,
  entries,
  expectedManifestSha256,
  stateDir,
  approveLocalTransfer = false,
}) {
  if (approveLocalTransfer !== true)
    throw new Error("TERMINAL_STAGE_OWNER_OPT_IN_REQUIRED");
  if (
    typeof expectedManifestSha256 !== "string" ||
    !SHA256.test(expectedManifestSha256)
  )
    throw new Error("TERMINAL_STAGE_MANIFEST_REQUIRED");
  const root = privateRoot(stateDir);
  if (
    typeof files?.root !== "string" ||
    !path.isAbsolute(files.root) ||
    inside(files.root, root) ||
    inside(root, files.root)
  )
    throw new Error("TERMINAL_STAGE_ROOT_OVERLAP");
  const plan = planTerminalWorkspaceSnapshot({
    files,
    readHead,
    expectedHead,
    entries,
  });
  if (plan.manifestSha256 !== expectedManifestSha256)
    throw new Error("TERMINAL_STAGE_MANIFEST_MISMATCH");

  // Collect all verified bytes before making any staging files. This
  // does not guarantee an atomic snapshot of a concurrently edited lane.
  const payload = plan.entries.map((entry) => {
    files.assertCommanderPath(entry.path);
    const read = files.read(entry.path);
    const bytes = Buffer.from(read.content, "utf8");
    if (
      read.sha256 !== entry.sha256 ||
      bytes.length !== entry.bytes ||
      digest(bytes) !== entry.sha256
    )
      throw new Error("TERMINAL_STAGE_SOURCE_CHANGED");
    return { path: entry.path, bytes };
  });
  if (readHead() !== expectedHead)
    throw new Error("TERMINAL_SNAPSHOT_HEAD_MISMATCH");

  const directory = fs.mkdtempSync(path.join(root, "terminal-stage-"));
  const identity = fs.lstatSync(directory);
  const rootIdentity = fs.lstatSync(root);
  let disposed = false;
  // Internal capability: the caller cannot supply a cleanup target. A changed
  // parent or directory is preserved for review rather than recursively removed.
  const dispose = () => {
    if (disposed) return { removed: false, alreadyDisposed: true };
    const checkedRoot = privateRoot(root);
    const currentRoot = fs.lstatSync(checkedRoot);
    const current = fs.lstatSync(directory);
    if (
      currentRoot.dev !== rootIdentity.dev ||
      currentRoot.ino !== rootIdentity.ino ||
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.uid !== process.getuid() ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      (current.mode & 0o077) !== 0 ||
      fs.realpathSync(directory) !== directory
    )
      throw new Error("TERMINAL_STAGE_CLEANUP_IDENTITY_CHANGED");
    fs.rmSync(directory, { recursive: true, force: false });
    disposed = true;
    return { removed: true, alreadyDisposed: false };
  };
  try {
    for (const item of payload) {
      const target = path.join(directory, ...item.path.split("/"));
      if (!inside(directory, target) || target === directory)
        throw new Error("TERMINAL_STAGE_INVALID_PATH");
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, item.bytes, { flag: "wx", mode: 0o600 });
      if (digest(fs.readFileSync(target)) !== digest(item.bytes))
        throw new Error("TERMINAL_STAGE_WRITE_UNVERIFIED");
    }
    if (readHead() !== expectedHead)
      throw new Error("TERMINAL_SNAPSHOT_HEAD_MISMATCH");
    return {
      directory,
      manifestSha256: plan.manifestSha256,
      files: plan.entries.length,
      bytes: plan.bytes,
      locallyStaged: true,
      containerTransferred: false,
      hostWriteBack: false,
      dispose,
    };
  } catch (error) {
    // Only the newly allocated directory under the trusted private root.
    dispose();
    throw error;
  }
}
