// Owner-pinned runtime closure for the P520 existing-enrollment launcher.
//
// Git HEAD / "no tracked changes" proves nothing about untracked files that Node will still load
// (node_modules, src). Instead the owner approves ONE manifest hash out of band; this module then proves
// that the runtime on disk is exactly the manifest: every listed file has the listed SHA-256, no other
// file exists under the covered roots, and nothing is a link or non-regular entry. Verification output is
// a fixed reason code only (no paths, no file content).
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { join, relative, resolve, sep, isAbsolute } from "node:path";

export const SCHEMA = "kmj-runtime-closure-v1";
export const COVERED_ROOTS = Object.freeze(["src", "node_modules"]);
export const COVERED_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/windows/ONE-CLICK-ANY-DEVICE.ps1",
]);
const HEX64 = /^[0-9a-f]{64}$/;
const TENANT = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FILES = 200000;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 3 * 1024 * 1024 * 1024;
const CHUNK = 1024 * 1024;

export class ClosureError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new ClosureError(code);
};

/**
 * Streaming, bounded SHA-256 of ONE regular, single-link file. The file is opened first (no symlink follow
 * where the OS supports O_NOFOLLOW) and the SAME handle is inspected and read, so a path swapped after the
 * check cannot change what was hashed; a change while reading is also detected.
 * `budget` ({left}) bounds the total bytes hashed across a whole runtime.
 */
export function sha256File(path, budget = { left: MAX_TOTAL_BYTES }) {
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink()) fail("LINK_IN_RUNTIME");
  if (!before.isFile()) fail("NON_REGULAR_IN_RUNTIME");
  if (before.nlink !== 1n) fail("HARDLINK_IN_RUNTIME");
  const fd = openSync(
    path,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
  );
  try {
    const st = fstatSync(fd, { bigint: true });
    if (
      !st.isFile() ||
      st.ino !== before.ino ||
      st.dev !== before.dev ||
      st.size !== before.size
    )
      fail("FILE_CHANGED_DURING_CHECK");
    if (st.nlink !== 1n) fail("HARDLINK_IN_RUNTIME");
    if (st.size > BigInt(MAX_FILE_BYTES)) fail("FILE_TOO_LARGE");
    if (st.size > BigInt(budget.left)) fail("RUNTIME_TOO_LARGE");
    budget.left -= Number(st.size);
    const hash = createHash("sha256");
    const buf = Buffer.allocUnsafe(CHUNK);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, null);
      if (n === 0) break;
      total += n;
      if (total > Number(st.size)) fail("FILE_CHANGED_DURING_CHECK");
      hash.update(buf.subarray(0, n));
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      total !== Number(st.size) ||
      after.size !== st.size ||
      after.mtimeNs !== st.mtimeNs
    )
      fail("FILE_CHANGED_DURING_CHECK");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function manifestSha256(manifest) {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

function walk(root, rel, out) {
  const abs = join(root, rel);
  const st = lstatSync(abs);
  if (st.isSymbolicLink()) fail("LINK_IN_RUNTIME");
  if (st.isDirectory()) {
    for (const name of readdirSync(abs).sort())
      walk(root, `${rel}/${name}`, out);
    return;
  }
  if (!st.isFile()) fail("NON_REGULAR_IN_RUNTIME");
  if (out.length >= MAX_FILES) fail("RUNTIME_TOO_LARGE");
  out.push(rel);
}

function coveredFiles(root) {
  const found = [];
  for (const dir of COVERED_ROOTS) {
    let st;
    try {
      st = lstatSync(join(root, dir));
    } catch {
      if (dir === "node_modules") continue; // a runtime without dependencies is still checkable
      fail("COVERED_ROOT_MISSING");
    }
    if (!st.isDirectory() || st.isSymbolicLink()) fail("LINK_IN_RUNTIME");
    walk(root, dir, found);
  }
  for (const file of COVERED_FILES) {
    let st;
    try {
      st = lstatSync(join(root, file));
    } catch {
      fail("COVERED_FILE_MISSING");
    }
    if (!st.isFile()) fail("NON_REGULAR_IN_RUNTIME");
    found.push(file);
  }
  return found;
}

export function buildManifest(root, binding) {
  checkBinding(binding);
  const files = {};
  const budget = { left: MAX_TOTAL_BYTES };
  for (const rel of coveredFiles(root))
    files[rel] = sha256File(join(root, rel), budget);
  return { schema: SCHEMA, binding, files };
}

function checkBinding(b) {
  if (
    !b ||
    typeof b.tenant !== "string" ||
    !TENANT.test(b.tenant) ||
    typeof b.deviceId !== "string" ||
    !/^[a-z0-9-]{3,100}$/.test(b.deviceId) ||
    typeof b.projectId !== "string" ||
    !/^[a-z0-9-]{3,100}$/.test(b.projectId) ||
    typeof b.nodeSha256 !== "string" ||
    !HEX64.test(b.nodeSha256)
  ) {
    fail("MANIFEST_BINDING_INVALID");
  }
}

/** Throws ClosureError(code) unless the runtime under `root` is exactly the owner-approved manifest. */
export function verifyRuntime(root, manifest, expectedManifestSha256) {
  if (
    typeof expectedManifestSha256 !== "string" ||
    !HEX64.test(expectedManifestSha256)
  )
    fail("MANIFEST_PIN_INVALID");
  if (
    !manifest ||
    manifest.schema !== SCHEMA ||
    typeof manifest.files !== "object" ||
    manifest.files === null
  )
    fail("MANIFEST_INVALID");
  checkBinding(manifest.binding);
  if (manifestSha256(manifest) !== expectedManifestSha256)
    fail("MANIFEST_NOT_OWNER_APPROVED");
  const onDisk = new Set(coveredFiles(root));
  const listed = Object.keys(manifest.files);
  for (const rel of listed) {
    if (
      !/^[A-Za-z0-9_.@+\-/]+$/.test(rel) ||
      rel.includes("..") ||
      isAbsolute(rel) ||
      !HEX64.test(manifest.files[rel])
    )
      fail("MANIFEST_INVALID");
    if (!onDisk.has(rel)) fail("MISSING_FILE");
  }
  for (const rel of onDisk) if (!(rel in manifest.files)) fail("EXTRA_FILE");
  const budget = { left: MAX_TOTAL_BYTES };
  for (const rel of listed)
    if (sha256File(join(root, rel), budget) !== manifest.files[rel])
      fail("FILE_HASH_MISMATCH");
  return true;
}

const FORBIDDEN_NODE_ENV = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_PENDING_DEPRECATION",
];

/**
 * Module resolution must come ONLY from the verified runtime: no NODE_OPTIONS/NODE_PATH-style env, no
 * preload flags on this process, and no node_modules / .node_modules / .node_libraries in any parent of the
 * runtime root (Node walks up the directory tree), nor in the user home.
 */
export function assertCleanNodeEnvironment(
  root,
  { env = process.env, execArgv = process.execArgv, home = null } = {},
) {
  for (const key of Object.keys(env))
    if (FORBIDDEN_NODE_ENV.includes(key.toUpperCase()) && env[key] !== "")
      fail("AMBIENT_NODE_ENV");
  if (execArgv.length > 0) fail("AMBIENT_NODE_FLAGS");
  const base = resolve(root);
  const dirs = [];
  for (let d = resolve(base, ".."); ; d = resolve(d, "..")) {
    dirs.push(d);
    if (resolve(d, "..") === d) break;
  }
  if (home) dirs.push(resolve(home));
  for (const d of dirs)
    for (const name of ["node_modules", ".node_modules", ".node_libraries"])
      try {
        lstatSync(join(d, name));
        fail("AMBIENT_NODE_MODULES");
      } catch (e) {
        if (e instanceof ClosureError) throw e;
      }
  return true;
}

export function verifyNode(nodePath, manifest) {
  if (sha256File(nodePath) !== manifest.binding.nodeSha256)
    fail("NODE_NOT_OWNER_APPROVED");
  return true;
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function assertNoLinkAncestors(path, stopAt) {
  let current = resolve(path);
  const stop = resolve(stopAt);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) fail("LINK_IN_ENROLLMENT_PATH");
    if (current === stop) return;
    const parent = resolve(current, "..");
    if (parent === current) fail("ENROLLMENT_OUTSIDE_STORE");
    current = parent;
  }
}

/**
 * Enrollment must belong to the owner-approved tenant/device/project, run only that one project from
 * THIS runtime directory, and keep its state under the private store (no link anywhere on the way).
 */
export function verifyEnrollment(cfg, manifest, { runtimeRoot, privateStore }) {
  const b = manifest.binding;
  if (!cfg || cfg.id !== b.deviceId) fail("ENROLLMENT_DEVICE_MISMATCH");
  if (cfg.tenant !== b.tenant) fail("ENROLLMENT_TENANT_MISMATCH");
  if (!Array.isArray(cfg.projects) || cfg.projects.length !== 1)
    fail("ENROLLMENT_NOT_SINGLE_PROJECT");
  const [project] = cfg.projects;
  if (project.id !== b.projectId) fail("ENROLLMENT_PROJECT_MISMATCH");
  if (typeof project.root !== "string" || !isAbsolute(project.root))
    fail("ENROLLMENT_PROJECT_ROOT_INVALID");
  if (realpathSync(project.root) !== realpathSync(runtimeRoot))
    fail("ENROLLMENT_PROJECT_ROOT_MISMATCH");
  if (typeof cfg.stateDir !== "string" || !isAbsolute(cfg.stateDir))
    fail("ENROLLMENT_STATE_INVALID");
  const store = realpathSync(privateStore);
  const state = resolve(cfg.stateDir);
  if (!isInside(store, state) && state !== store)
    fail("ENROLLMENT_OUTSIDE_STORE");
  assertNoLinkAncestors(state, store);
  return true;
}

export const _internal = { isInside, sep };
