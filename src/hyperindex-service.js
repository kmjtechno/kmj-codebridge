import fs from "node:fs";
import path from "node:path";
import { hash } from "./policy.js";
import { HyperIndex, safeIndexContent } from "./hyperindex.js";
function directory(stateDir, files, project, create) {
  if (typeof stateDir !== "string") throw Error("INDEX_STATE_UNAVAILABLE");
  const base = path.resolve(stateDir),
    s = fs.lstatSync(base);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    fs.realpathSync(base) !== base ||
    s.mode & 0o022 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw Error("INDEX_STATE_UNSAFE");
  if (base === files.root || base.startsWith(files.root + path.sep))
    throw Error("INDEX_STATE_INSIDE_PROJECT");
  let dir = base;
  for (const part of [
    "hyperindex",
    hash(JSON.stringify([project, files.root])),
  ]) {
    dir = path.join(dir, part);
    if (create) {
      try {
        fs.mkdirSync(dir, { mode: 0o700 });
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
    }
    const entry = fs.lstatSync(dir);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.mode & 0o077 ||
      (process.getuid && entry.uid !== process.getuid())
    )
      throw Error("INDEX_STATE_UNSAFE");
  }
  return dir;
}
export function hyperIndexOperation(
  name,
  { files, stateDir, project, query, maxResults },
) {
  if (name === "hyperindex_status") {
    if (process.platform === "win32")
      return {
        supported: false,
        state: "unavailable",
        reason: "WINDOWS_ACL_UNVERIFIED",
      };
    try {
      const dir = directory(stateDir, files, project, false);
      const s = fs.lstatSync(path.join(dir, "hyperindex.sqlite"));
      return {
        supported: true,
        state: "present_unverified",
        integrityVerified: false,
        bytes: s.isFile() && !s.isSymbolicLink() ? s.size : null,
      };
    } catch (error) {
      return {
        supported: true,
        state: error.code === "ENOENT" ? "missing" : "unavailable",
        integrityVerified: false,
      };
    }
  }
  let index;
  try {
    if (process.platform === "win32")
      throw Error("INDEX_WINDOWS_ACL_UNVERIFIED");
    const dir = directory(
      stateDir,
      files,
      project,
      name === "hyperindex_build",
    );
    if (
      name !== "hyperindex_build" &&
      !fs.existsSync(path.join(dir, "hyperindex.sqlite"))
    )
      throw Error("INDEX_MISSING");
    index = new HyperIndex(files, dir);
    if (name === "hyperindex_build")
      return {
        built: true,
        adapter: "sqlite-trigram-v1",
        coverage: index.refresh(),
      };
    return { ...index.search(query, { maxResults }), fallback: false };
  } catch (error) {
    if (name === "hyperindex_build") throw error;
    const result = files.search(query, { maxResults });
    return {
      ...result,
      matches: result.matches.flatMap((m) => {
        try {
          const file = files.read(m.path);
          const line = safeIndexContent(file.content).split("\n")[m.line - 1];
          return typeof line === "string" && line.includes(query)
            ? [{ ...m, text: line.slice(0, 500) }]
            : [];
        } catch {
          return [];
        }
      }),
      adapter: "bounded-lexical-v1",
      fallback: true,
      fallbackReason: "INDEX_UNAVAILABLE",
      freshness: "live_bounded_scan",
    };
  } finally {
    index?.close();
  }
}
