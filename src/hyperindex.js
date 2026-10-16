import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hash, ProjectFiles } from "./policy.js";
import { redact } from "./jobs.js";

function safeContent(text) {
  return redact(
    text.replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g,
      (block) =>
        "[REDACTED PRIVATE KEY]" +
        "\n".repeat((block.match(/\n/g) || []).length),
    ),
  );
}

// Deliberately opt-in backend foundation. Never serves an unreconciled snapshot.
// Same Unix account is trusted, as in ProjectFiles; this is not a hostile-UID sandbox.
export class HyperIndex {
  constructor(files, stateDir) {
    if (process.platform === "win32")
      throw Error("INDEX_WINDOWS_ACL_UNVERIFIED");
    if (!(files instanceof ProjectFiles)) throw Error("INDEX_POLICY_REQUIRED");
    this.files = files;
    stateDir = path.resolve(stateDir);
    const state = fs.lstatSync(stateDir);
    if (
      !state.isDirectory() ||
      (process.getuid && state.uid !== process.getuid()) ||
      state.isSymbolicLink() ||
      state.mode & 0o077 ||
      fs.realpathSync(stateDir) !== path.resolve(stateDir)
    )
      throw Error("INDEX_STATE_UNSAFE");
    if (
      stateDir === files.root ||
      path.resolve(stateDir).startsWith(files.root + path.sep)
    )
      throw Error("INDEX_STATE_INSIDE_PROJECT");
    const filename = path.join(stateDir, "hyperindex.sqlite");
    const fd = fs.openSync(
      filename,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const s = fs.fstatSync(fd);
      if (
        !s.isFile() ||
        s.nlink !== 1 ||
        s.mode & 0o077 ||
        (process.getuid && s.uid !== process.getuid())
      )
        throw Error("INDEX_FILE_UNSAFE");
    } finally {
      fs.closeSync(fd);
    }
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec(
        'PRAGMA trusted_schema=OFF; PRAGMA journal_mode=MEMORY; PRAGMA max_page_count=16384; CREATE TABLE IF NOT EXISTS identity (root TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files (path TEXT PRIMARY KEY, sha TEXT NOT NULL, content TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(path UNINDEXED, content, tokenize="trigram");',
      );
      const identity = hash(files.root);
      const row = this.db.prepare("SELECT root FROM identity").get();
      if (row && row.root !== identity) throw Error("INDEX_PROJECT_MISMATCH");
      if (!row)
        this.db.prepare("INSERT INTO identity VALUES (?)").run(identity);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close() {
    this.db.close();
  }
  refresh() {
    const accepted = new Map();
    let visited = 0,
      bytes = 0,
      truncated = false,
      skipped = 0;
    const walk = (dir, depth) => {
      if (depth > 12) {
        truncated = true;
        return;
      }
      let listing;
      try {
        listing = this.files.list(dir);
      } catch {
        truncated = true;
        return;
      }
      if (listing.truncated) truncated = true;
      for (const entry of listing.entries) {
        if (++visited > 2000 || bytes >= 8 * 1024 * 1024) {
          truncated = true;
          return;
        }
        const relative = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.type === "directory") {
          walk(relative, depth + 1);
          continue;
        }
        if (entry.type !== "file") continue;
        try {
          const file = this.files.read(relative);
          bytes += file.bytes;
          if (bytes > 8 * 1024 * 1024) {
            truncated = true;
            return;
          }
          // Recognized credential bindings never enter the database. Filename policy
          // and this detector are defense in depth, not a universal secret detector.
          accepted.set(relative, file);
        } catch {
          skipped++;
        }
      }
    };
    walk("", 0);
    let updated = 0,
      removed = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of this.db.prepare("SELECT path,sha FROM files").all()) {
        const file = accepted.get(row.path);
        if (!file || file.sha256 !== row.sha) {
          this.db.prepare("DELETE FROM files WHERE path=?").run(row.path);
          this.db.prepare("DELETE FROM search WHERE path=?").run(row.path);
          removed++;
        } else accepted.delete(row.path);
      }
      for (const [name, file] of accepted) {
        const content = safeContent(file.content);
        this.db
          .prepare("INSERT INTO files VALUES (?,?,?)")
          .run(name, file.sha256, content);
        this.db.prepare("INSERT INTO search VALUES (?,?)").run(name, content);
        updated++;
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.coverage = { visited, bytes, truncated, skipped, updated, removed };
    return this.coverage;
  }
  search(query, { maxResults = 100 } = {}) {
    if (typeof query !== "string" || !query || query.length > 200)
      throw Error("INVALID_QUERY");
    if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 100)
      throw Error("INVALID_SEARCH_LIMIT");
    const coverage = this.refresh();
    // Trigram phrases are only a candidate filter. Exact substring semantics and
    // current policy-checked bytes decide every returned line.
    const rows =
      query.length >= 3 && /^[\x20-\x7e]+$/.test(query)
        ? this.db
            .prepare(
              "SELECT path FROM search WHERE search MATCH ? ORDER BY path",
            )
            .all('"' + query.replaceAll('"', '""') + '"')
        : this.db.prepare("SELECT path FROM files ORDER BY path").all();
    const matches = [];
    let truncated = coverage.truncated;
    for (const row of rows) {
      let file;
      try {
        file = this.files.read(row.path);
      } catch {
        truncated = true;
        continue;
      }
      const cached = this.db
        .prepare("SELECT sha FROM files WHERE path=?")
        .get(row.path);
      if (cached?.sha !== file.sha256) {
        truncated = true;
        continue;
      }
      for (const [i, line] of safeContent(file.content).split("\n").entries())
        if (line.includes(query)) {
          if (matches.length === maxResults) {
            truncated = true;
            break;
          }
          matches.push({
            path: row.path,
            line: i + 1,
            text: line.slice(0, 500),
          });
        }
      if (matches.length === maxResults) {
        truncated = true;
        break;
      }
    }
    return {
      matches,
      truncated,
      freshness: "reconciled",
      adapter: "sqlite-trigram-v1",
      coverage,
    };
  }
}
