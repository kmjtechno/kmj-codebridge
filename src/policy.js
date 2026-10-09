import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import {
  extractLexicalSymbols,
  findIdentifierLocations,
  languageForExtension,
  REPO_INTELLIGENCE_ADAPTER,
} from "./repo-intelligence.js";
export const MAX_FILE_BYTES = 262144;
export const hash = (text) => createHash("sha256").update(text).digest("hex");
const denied =
  /(^\.env($|\.)|^\.git$|^\.ssh$|^\.aws$|^\.azure$|^\.kube$|^\.npmrc$|^\.netrc$|^id_(rsa|ed25519)|credential|secret|token|\.(pem|key|p12|pfx|keystore)$)/i;
const skipped = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  ".venv",
  ".superpowers",
]);
const decoder = new TextDecoder("utf-8", { fatal: true });
export class ProjectFiles {
  constructor(root) {
    if (!path.isAbsolute(root)) fail("ROOT_MUST_BE_ABSOLUTE");
    this.root = fs.realpathSync(root);
    if (!fs.statSync(this.root).isDirectory()) fail("INVALID_ROOT");
  }
  resolve(relative, allowMissing = false) {
    if (
      typeof relative !== "string" ||
      !relative ||
      relative.length > 1024 ||
      path.isAbsolute(relative) ||
      /[\\:\x00-\x1f]/.test(relative)
    )
      fail("INVALID_PATH");
    const parts = relative.split("/");
    if (
      parts.some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          /[. ]$/.test(p) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p),
      )
    )
      fail("INVALID_PATH");
    if (parts.some((p) => denied.test(p))) fail("PATH_DENIED");
    let current = this.root;
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let st;
      try {
        st = fs.lstatSync(current);
      } catch (e) {
        if (e.code === "ENOENT" && allowMissing && i === parts.length - 1)
          return current;
        fail("FILE_NOT_FOUND");
      }
      if (st.isSymbolicLink()) fail("SYMLINK_DENIED");
      if (i < parts.length - 1 && !st.isDirectory()) fail("INVALID_PATH");
      if (i === parts.length - 1 && (!st.isFile() || st.nlink !== 1))
        fail(st.nlink > 1 ? "HARDLINK_DENIED" : "NOT_REGULAR_FILE");
    }
    return current;
  }
  list(relative = "") {
    if (typeof relative !== "string" || relative.length > 1024)
      fail("INVALID_PATH");
    let dir = this.root;
    if (relative) {
      if (path.isAbsolute(relative) || /[\\:\x00-\x1f]/.test(relative))
        fail("INVALID_PATH");
      const parts = relative.split("/");
      if (
        parts.some(
          (p) =>
            !p || p === "." || p === ".." || /[. ]$/.test(p) || denied.test(p),
        )
      )
        fail("INVALID_PATH");
      for (const part of parts) {
        dir = path.join(dir, part);
        let st;
        try {
          st = fs.lstatSync(dir);
        } catch {
          fail("FILE_NOT_FOUND");
        }
        if (st.isSymbolicLink() || !st.isDirectory()) fail("INVALID_PATH");
      }
    }
    const entries = [];
    let truncated = false;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (
        denied.test(item.name) ||
        skipped.has(item.name) ||
        item.isSymbolicLink() ||
        item.name.startsWith(".codebridge-")
      )
        continue;
      if (entries.length >= 500) {
        truncated = true;
        break;
      }
      entries.push({
        name: item.name,
        type: item.isDirectory()
          ? "directory"
          : item.isFile()
            ? "file"
            : "other",
      });
    }
    return { path: relative, entries, truncated };
  }
  tree(relative = "", maxDepth = 3, maxEntries = 100) {
    if (
      !Number.isInteger(maxDepth) ||
      maxDepth < 0 ||
      maxDepth > 5 ||
      !Number.isInteger(maxEntries) ||
      maxEntries < 1 ||
      maxEntries > 200
    )
      fail("INVALID_TREE_LIMIT");
    const entries = [];
    let truncated = false;
    const walk = (dir, depth) => {
      const listing = this.list(dir);
      for (const entry of listing.entries) {
        if (entries.length >= maxEntries) {
          truncated = true;
          return;
        }
        if (entry.type === "other") continue;
        const relativePath = dir ? `${dir}/${entry.name}` : entry.name;
        entries.push({ path: relativePath, type: entry.type, depth });
        if (entry.type === "directory" && depth < maxDepth) {
          walk(relativePath, depth + 1);
          if (entries.length >= maxEntries) {
            truncated = true;
            return;
          }
        }
      }
      if (listing.truncated) truncated = true;
    };
    walk(relative, 0);
    return { path: relative, entries, truncated, maxDepth, maxEntries };
  }
  integrityManifest(relative = "", maxDepth = 2, maxFiles = 40) {
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 5 ||
        !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 60)
      fail("INVALID_MANIFEST_LIMIT");

    // Share the ordinary project explorer's denylist and no-symlink policy.
    // Collect at most 200 paths; never recurse into excluded build caches,
    // credentials, node_modules, or outside the approved project root.
    const walk = this.tree(relative, maxDepth, 200);
    const entries = [];
    let bytesHashed = 0;
    let truncated = walk.truncated;
    for (const item of walk.entries) {
      if (item.type !== "file") continue;
      if (entries.length >= maxFiles) {
        truncated = true;
        break;
      }
      this.assertCommanderPath(item.path);
      const info = this.fileInfo(item.path);
      // All returned digests are from the same guarded ProjectFiles.read
      // path as ordinary MCP reads. Never return source content.
      if (info.bytes > MAX_FILE_BYTES || bytesHashed + info.bytes > 1048576) {
        entries.push({ path: item.path, bytes: info.bytes, status: "too_large", sha256: null });
        continue;
      }
      try {
        const read = this.read(item.path);
        entries.push({ path: item.path, bytes: read.bytes, status: "hashed", sha256: read.sha256 });
        bytesHashed += read.bytes;
      } catch (error) {
        if (error?.message !== "BINARY_FILE" && error?.message !== "FILE_TOO_LARGE")
          throw error;
        entries.push({ path: item.path, bytes: info.bytes, status: "non_text", sha256: null });
      }
    }

    // This digest represents the bounded *manifest*, not the whole project
    // when traversal is truncated. It is neither a Git commit nor an
    // attestation that all files were tested or unchanged.
    const snapshotSha256 = hash(JSON.stringify({ path: relative, entries, truncated }));
    return {
      path: relative,
      entries,
      files: entries.length,
      bytesHashed,
      truncated,
      snapshotSha256,
      coverage: truncated ? "partial" : "bounded",
    };
  }
  fileInfo(relative) {
    const target = this.resolve(relative);
    const fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1)
        fail(st.nlink > 1 ? "HARDLINK_DENIED" : "NOT_REGULAR_FILE");
      return {
        path: relative,
        type: "file",
        bytes: st.size,
        modifiedAt: st.mtime.toISOString(),
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  assertCommanderPath(relative) {
    if (
      typeof relative !== "string" ||
      relative
        .split("/")
        .some((part) => skipped.has(part) || part.startsWith(".codebridge-"))
    )
      fail("PATH_DENIED");
  }
  createDirectory(relative) {
    this.assertCommanderPath(relative);
    const target = this.resolve(relative, true);
    try {
      fs.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if (error.code === "EEXIST") fail("DIRECTORY_EXISTS");
      throw error;
    }
    return { path: relative, created: true };
  }
  moveFile(from, to, expectedHash) {
    if (from === to) fail("INVALID_MOVE");
    this.assertCommanderPath(from);
    this.assertCommanderPath(to);
    if (
      typeof expectedHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedHash)
    )
      fail("INVALID_HASH");
    const source = this.resolve(from);
    const destination = this.resolve(to, true);
    const sourceFd = fs.openSync(
      source,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    let copied = false;
    let removed = false;
    try {
      const stat = fs.fstatSync(sourceFd);
      if (!stat.isFile() || stat.nlink !== 1)
        fail(stat.nlink > 1 ? "HARDLINK_DENIED" : "NOT_REGULAR_FILE");
      if (stat.size > MAX_FILE_BYTES) fail("FILE_TOO_LARGE");
      const contents = Buffer.alloc(stat.size);
      const count = fs.readSync(sourceFd, contents, 0, contents.length, 0);
      if (count !== stat.size || hash(contents) !== expectedHash)
        fail("CONTENT_CONFLICT");

      // wx gives exclusive creation: an existing destination is NEVER replaced.
      const destinationFd = fs.openSync(destination, "wx", 0o600);
      copied = true;
      try {
        fs.writeFileSync(destinationFd, contents);
        fs.fsyncSync(destinationFd);
      } finally {
        fs.closeSync(destinationFd);
      }

      // Refuse to remove the source after a replacement or concurrent edit.
      const current = fs.lstatSync(source);
      const sourceNow = fs.fstatSync(sourceFd);
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1 ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        sourceNow.size !== stat.size
      )
        fail("CONTENT_CONFLICT");
      const verified = Buffer.alloc(stat.size);
      const n = fs.readSync(sourceFd, verified, 0, verified.length, 0);
      if (n !== stat.size || hash(verified) !== expectedHash)
        fail("CONTENT_CONFLICT");

      const copiedFd = fs.openSync(
        destination,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      try {
        const copyStat = fs.fstatSync(copiedFd);
        if (copyStat.size > MAX_FILE_BYTES) fail("FILE_TOO_LARGE");
        const copy = Buffer.alloc(copyStat.size);
        const bytes = fs.readSync(copiedFd, copy, 0, copy.length, 0);
        if (
          !copyStat.isFile() ||
          copyStat.nlink !== 1 ||
          bytes !== stat.size ||
          hash(copy) !== expectedHash
        )
          fail("COPY_INTEGRITY_FAILED");
      } finally {
        fs.closeSync(copiedFd);
      }

      fs.unlinkSync(source);
      removed = true;
      return { from, to, sha256: expectedHash, bytes: stat.size, moved: true };
    } catch (error) {
      // On an incomplete move, only clean up bytes still matching our copy.
      // Do not delete a destination subsequently modified by another writer.
      if (copied && !removed) {
        try {
          const dst = fs.lstatSync(destination);
          if (dst.isFile() && !dst.isSymbolicLink() && dst.nlink === 1) {
            const bytes = fs.readFileSync(destination);
            if (hash(bytes) === expectedHash) fs.unlinkSync(destination);
          }
        } catch {}
      }
      if (error.code === "EEXIST") fail("DESTINATION_EXISTS");
      throw error;
    } finally {
      fs.closeSync(sourceFd);
    }
  }
  copyFile(from, to, expectedHash) {
    if (from === to) fail("INVALID_COPY");
    this.assertCommanderPath(from);
    this.assertCommanderPath(to);
    if (
      typeof expectedHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(expectedHash)
    )
      fail("INVALID_HASH");

    const source = this.resolve(from);
    const destination = this.resolve(to, true);
    const sourceFd = fs.openSync(
      source,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    let created = false;
    try {
      const st = fs.fstatSync(sourceFd);
      if (!st.isFile() || st.nlink !== 1)
        fail(st.nlink > 1 ? "HARDLINK_DENIED" : "NOT_REGULAR_FILE");
      if (st.size > MAX_FILE_BYTES) fail("FILE_TOO_LARGE");
      const bytes = Buffer.alloc(st.size);
      if (fs.readSync(sourceFd, bytes, 0, st.size, 0) !== st.size)
        fail("CONTENT_CONFLICT");
      if (hash(bytes) !== expectedHash) fail("CONTENT_CONFLICT");

      // Exclusive create: no destination overwrite, including symlinks.
      const destinationFd = fs.openSync(destination, "wx", 0o600);
      created = true;
      try {
        fs.writeFileSync(destinationFd, bytes);
        fs.fsyncSync(destinationFd);
      } finally {
        fs.closeSync(destinationFd);
      }

      // Reopen the copy without following links; verify its full contents.
      const destinationCheck = fs.openSync(
        destination,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      try {
        const actual = fs.fstatSync(destinationCheck);
        if (
          !actual.isFile() ||
          actual.nlink !== 1 ||
          actual.size !== bytes.length
        )
          fail("COPY_INTEGRITY_FAILED");
        const verified = Buffer.alloc(actual.size);
        if (
          fs.readSync(destinationCheck, verified, 0, verified.length, 0) !==
            verified.length ||
          hash(verified) !== expectedHash
        )
          fail("COPY_INTEGRITY_FAILED");
      } finally {
        fs.closeSync(destinationCheck);
      }
      return {
        from,
        to,
        sha256: expectedHash,
        bytes: bytes.length,
        copied: true,
      };
    } catch (error) {
      if (created) {
        try {
          const current = fs.lstatSync(destination);
          if (
            current.isFile() &&
            !current.isSymbolicLink() &&
            current.nlink === 1
          ) {
            const bytes = fs.readFileSync(destination);
            if (hash(bytes) === expectedHash) fs.unlinkSync(destination);
          }
        } catch {}
      }
      if (error.code === "EEXIST") fail("DESTINATION_EXISTS");
      throw error;
    } finally {
      fs.closeSync(sourceFd);
    }
  }
  read(relative) {
    const target = this.resolve(relative);
    const fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
    );
    try {
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) fail("NOT_REGULAR_FILE");
      if (st.size > MAX_FILE_BYTES) fail("FILE_TOO_LARGE");
      const buf = Buffer.alloc(MAX_FILE_BYTES + 1);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      if (n > MAX_FILE_BYTES) fail("FILE_TOO_LARGE");
      const bytes = buf.subarray(0, n);
      if (bytes.includes(0)) fail("BINARY_FILE");
      let content;
      try {
        content = decoder.decode(bytes);
      } catch {
        fail("BINARY_FILE");
      }
      return { path: relative, content, sha256: hash(bytes), bytes: n };
    } finally {
      fs.closeSync(fd);
    }
  }
  readRange(relative, startLine = 1, maxLines = 200) {
    if (
      !Number.isInteger(startLine) ||
      startLine < 1 ||
      !Number.isInteger(maxLines) ||
      maxLines < 1 ||
      maxLines > 500
    )
      fail("INVALID_RANGE");
    const file = this.read(relative);
    const lines = file.content.split("\n");
    const start = Math.min(startLine - 1, lines.length);
    const end = Math.min(start + maxLines, lines.length);
    return {
      path: relative,
      content: lines.slice(start, end).join("\n"),
      sha256: file.sha256,
      bytes: file.bytes,
      startLine,
      endLine: end,
      totalLines: lines.length,
      hasMore: end < lines.length,
    };
  }
  preview(relative, content, expectedHash) {
    if (typeof content !== "string" || content.includes("\0"))
      fail("INVALID_CONTENT");
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) fail("FILE_TOO_LARGE");
    const target = this.resolve(relative, true);
    const exists = fs.existsSync(target);
    const before = exists ? this.read(relative) : null;
    if ((before?.sha256 ?? null) !== expectedHash) fail("CONTENT_CONFLICT");
    return {
      path: relative,
      previous_sha256: before?.sha256 ?? null,
      sha256: hash(content),
      changed: before?.content !== content,
      bytes: Buffer.byteLength(content),
    };
  }
  write(relative, content, expectedHash) {
    const preview = this.preview(relative, content, expectedHash);
    const target = this.resolve(relative, true);
    const tmp = path.join(
      path.dirname(target),
      `.codebridge-${randomUUID()}.tmp`,
    );
    const mode = fs.existsSync(target)
      ? fs.statSync(target).mode & 0o777
      : 0o600;
    try {
      const fd = fs.openSync(tmp, "wx", mode);
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.preview(relative, content, expectedHash);
      fs.renameSync(tmp, target);
      return preview;
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  edit(relative, oldText, newText, expectedHash) {
    if (
      typeof oldText !== "string" ||
      !oldText ||
      typeof newText !== "string" ||
      oldText.includes("\0") ||
      newText.includes("\0") ||
      Buffer.byteLength(oldText) > 65536 ||
      Buffer.byteLength(newText) > 65536
    )
      fail("INVALID_CONTENT");
    const before = this.read(relative);
    if (before.sha256 !== expectedHash) fail("CONTENT_CONFLICT");
    const first = before.content.indexOf(oldText);
    if (first < 0) fail("EDIT_TEXT_NOT_FOUND");
    if (before.content.indexOf(oldText, first + oldText.length) >= 0)
      fail("EDIT_TEXT_AMBIGUOUS");
    const content =
      before.content.slice(0, first) +
      newText +
      before.content.slice(first + oldText.length);
    return this.write(relative, content, expectedHash);
  }
  writeBatch(changes) {
    if (!Array.isArray(changes) || changes.length < 1 || changes.length > 50)
      fail("INVALID_BATCH");
    const seen = new Set();
    const staged = [];
    try {
      for (const change of changes) {
        if (
          !change ||
          typeof change.path !== "string" ||
          typeof change.content !== "string" ||
          !Object.hasOwn(change, "expectedHash")
        )
          fail("INVALID_BATCH");
        if (seen.has(change.path)) fail("DUPLICATE_PATH");
        seen.add(change.path);
        const preview = this.preview(
          change.path,
          change.content,
          change.expectedHash,
        );
        const target = this.resolve(change.path, true);
        const mode = fs.existsSync(target)
          ? fs.statSync(target).mode & 0o777
          : 0o600;
        const tmp = path.join(
          path.dirname(target),
          `.codebridge-${randomUUID()}.batch`,
        );
        const fd = fs.openSync(tmp, "wx", mode);
        try {
          fs.writeFileSync(fd, change.content);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        staged.push({ change, preview, target, tmp });
      }

      for (const item of staged)
        this.preview(
          item.change.path,
          item.change.content,
          item.change.expectedHash,
        );

      const backups = [];
      try {
        for (const item of staged) {
          let backup = null;
          if (fs.existsSync(item.target)) {
            backup = path.join(
              path.dirname(item.target),
              `.codebridge-${randomUUID()}.backup`,
            );
            fs.renameSync(item.target, backup);
          }
          backups.push({ target: item.target, backup });
          fs.renameSync(item.tmp, item.target);
        }
      } catch (error) {
        for (let i = backups.length - 1; i >= 0; i--) {
          const { target, backup } = backups[i];
          try {
            if (fs.existsSync(target)) fs.unlinkSync(target);
          } catch {}
          if (backup) {
            try {
              fs.renameSync(backup, target);
            } catch {}
          }
        }
        throw error;
      }

      for (const { backup } of backups) {
        if (!backup) continue;
        try {
          fs.unlinkSync(backup);
        } catch {}
      }

      return {
        changed: staged.map(({ preview }) => preview),
        count: staged.length,
      };
    } finally {
      for (const { tmp } of staged) {
        try {
          fs.unlinkSync(tmp);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
  }
  repoIntelligence(
    identifier,
    operation = "both",
    maxFiles = 80,
    maxResults = 200,
  ) {
    if (
      typeof identifier !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]{0,79}$/.test(identifier) ||
      !["definitions", "references", "both"].includes(operation) ||
      !Number.isInteger(maxFiles) ||
      maxFiles < 1 ||
      maxFiles > 200 ||
      !Number.isInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 500
    )
      fail("INVALID_REPO_INTELLIGENCE");

    const files = [];
    let visitedEntries = 0;
    let scannedBytes = 0;
    let resultCount = 0;
    let truncated = false;

    const walk = (dir, depth) => {
      if (
        depth > 12 ||
        truncated ||
        files.length >= maxFiles ||
        resultCount >= maxResults
      ) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = fs.readdirSync(path.join(this.root, dir), {
          withFileTypes: true,
        });
      } catch {
        return;
      }
      for (const item of entries) {
        if (++visitedEntries > 4000 || scannedBytes >= 16 * 1024 * 1024) {
          truncated = true;
          return;
        }
        if (
          denied.test(item.name) ||
          skipped.has(item.name) ||
          item.isSymbolicLink() ||
          item.name.startsWith(".codebridge-")
        )
          continue;
        const relative = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory()) {
          walk(relative, depth + 1);
          if (truncated) return;
          continue;
        }
        if (!item.isFile()) continue;

        const language = languageForExtension(path.extname(item.name));
        if (!language) continue;
        let file;
        try {
          file = this.read(relative);
        } catch {
          continue;
        }
        scannedBytes += file.bytes;

        const allSymbols = extractLexicalSymbols(file.content, 100);
        const definitions =
          operation === "references"
            ? []
            : allSymbols.filter((symbol) => symbol.name === identifier);
        const definitionLines = new Set(
          allSymbols
            .filter((symbol) => symbol.name === identifier)
            .map((symbol) => symbol.line),
        );
        const remaining = Math.max(0, maxResults - resultCount);
        const references =
          operation === "definitions" || remaining === 0
            ? []
            : findIdentifierLocations(file.content, identifier, remaining).map(
                (location) => ({
                  ...location,
                  isDefinition: definitionLines.has(location.line),
                }),
              );

        const count = definitions.length + references.length;
        if (!count) continue;
        resultCount += count;
        files.push({
          path: relative,
          language,
          definitions,
          references,
        });
        if (files.length >= maxFiles || resultCount >= maxResults) {
          truncated = true;
          return;
        }
      }
    };
    walk("", 0);

    return {
      adapter: REPO_INTELLIGENCE_ADAPTER,
      fallback: true,
      identifier,
      operation,
      files,
      fileCount: files.length,
      resultCount,
      visitedEntries,
      scannedBytes,
      truncated,
    };
  }
  repoMap(query = "", maxFiles = 80, maxSymbolsPerFile = 12) {
    if (
      typeof query !== "string" ||
      query.length > 120 ||
      !Number.isInteger(maxFiles) ||
      maxFiles < 1 ||
      maxFiles > 200 ||
      !Number.isInteger(maxSymbolsPerFile) ||
      maxSymbolsPerFile < 1 ||
      maxSymbolsPerFile > 50
    )
      fail("INVALID_REPO_MAP");

    const languages = new Map([
      [".js", "javascript"],
      [".jsx", "javascript"],
      [".mjs", "javascript"],
      [".cjs", "javascript"],
      [".ts", "typescript"],
      [".tsx", "typescript"],
      [".py", "python"],
      [".php", "php"],
      [".go", "go"],
      [".rs", "rust"],
      [".java", "java"],
      [".kt", "kotlin"],
      [".kts", "kotlin"],
      [".cs", "csharp"],
      [".c", "c"],
      [".h", "c"],
      [".cc", "cpp"],
      [".cpp", "cpp"],
      [".cxx", "cpp"],
      [".hpp", "cpp"],
      [".hh", "cpp"],
      [".rb", "ruby"],
      [".swift", "swift"],
    ]);
    const manifests = new Set([
      "package.json",
      "composer.json",
      "pyproject.toml",
      "Cargo.toml",
      "go.mod",
      "pom.xml",
      "build.gradle",
      "build.gradle.kts",
      "Dockerfile",
      "Makefile",
      "README.md",
      "tsconfig.json",
    ]);
    const symbolPatterns = [
      [
        "function",
        /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/,
      ],
      [
        "function",
        /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/,
      ],
      [
        "class",
        /(?:^|\s)(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/,
      ],
      [
        "type",
        /(?:^|\s)(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
      ],
      ["function", /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
      ["class", /^\s*class\s+([A-Za-z_]\w*)\b/],
      ["function", /\bfunction\s+([A-Za-z_]\w*)\s*\(/],
      ["function", /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/],
      ["type", /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/],
      [
        "function",
        /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/,
      ],
      [
        "type",
        /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)\b/,
      ],
    ];

    const q = query.trim().toLowerCase();
    const candidates = [];
    let visited = 0;
    let scannedBytes = 0;
    let truncated = false;

    const walk = (dir, depth) => {
      if (depth > 12 || truncated) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = fs.readdirSync(path.join(this.root, dir), {
          withFileTypes: true,
        });
      } catch {
        return;
      }
      for (const item of entries) {
        if (++visited > 4000 || scannedBytes >= 16 * 1024 * 1024) {
          truncated = true;
          return;
        }
        if (
          denied.test(item.name) ||
          skipped.has(item.name) ||
          item.isSymbolicLink() ||
          item.name.startsWith(".codebridge-")
        )
          continue;
        const rel = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory()) {
          walk(rel, depth + 1);
          if (truncated) return;
          continue;
        }
        if (!item.isFile()) continue;

        const ext = path.extname(item.name).toLowerCase();
        const language = languages.get(ext) ?? null;
        const manifest = manifests.has(item.name);
        if (!language && !manifest) continue;

        let file;
        try {
          file = this.read(rel);
        } catch {
          continue;
        }
        scannedBytes += file.bytes;

        const symbols = [];
        const seen = new Set();
        for (const [index, line] of file.content.split("\n").entries()) {
          for (const [kind, pattern] of symbolPatterns) {
            const match = line.match(pattern);
            const name = match?.[1];
            if (!name || seen.has(name)) continue;
            seen.add(name);
            symbols.push({ kind, name, line: index + 1 });
            if (symbols.length >= maxSymbolsPerFile) break;
          }
          if (symbols.length >= maxSymbolsPerFile) break;
        }

        let score = manifest ? 40 : 10;
        const lowerPath = rel.toLowerCase();
        if (q) {
          if (lowerPath.includes(q)) score += 120;
          if (symbols.some((symbol) => symbol.name.toLowerCase().includes(q)))
            score += 90;
          if (file.content.toLowerCase().includes(q)) score += 25;
        }
        if (/^(src|app|lib|packages|apps)\//.test(rel)) score += 10;
        candidates.push({
          path: rel,
          bytes: file.bytes,
          language: language ?? "manifest",
          manifest,
          symbols,
          score,
        });
        if (candidates.length >= 1000) {
          truncated = true;
          return;
        }
      }
    };
    walk("", 0);

    candidates.sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path),
    );
    const selected = candidates
      .slice(0, maxFiles)
      .map(({ score, ...file }) => file);
    return {
      query,
      files: selected,
      count: selected.length,
      candidateFiles: candidates.length,
      visitedEntries: visited,
      scannedBytes,
      truncated: truncated || candidates.length > selected.length,
    };
  }

  search(query) {
    if (typeof query !== "string" || !query || query.length > 200)
      fail("INVALID_QUERY");
    const matches = [];
    let visited = 0,
      bytes = 0,
      truncated = false;
    const walk = (dir, depth) => {
      if (depth > 12) {
        truncated = true;
        return;
      }
      for (const item of fs.readdirSync(path.join(this.root, dir), {
        withFileTypes: true,
      })) {
        if (
          ++visited > 2000 ||
          matches.length >= 100 ||
          bytes >= 8 * 1024 * 1024
        ) {
          truncated = true;
          return;
        }
        if (
          denied.test(item.name) ||
          skipped.has(item.name) ||
          item.isSymbolicLink() ||
          item.name.startsWith(".codebridge-")
        )
          continue;
        const rel = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory()) {
          walk(rel, depth + 1);
          continue;
        }
        if (!item.isFile()) continue;
        let file;
        try {
          file = this.read(rel);
        } catch {
          continue;
        }
        bytes += file.bytes;
        for (const [index, line] of file.content.split("\n").entries()) {
          if (line.includes(query)) {
            matches.push({
              path: rel,
              line: index + 1,
              text: line.slice(0, 500),
            });
            if (matches.length >= 100) {
              truncated = true;
              break;
            }
          }
        }
      }
    };
    walk("", 0);
    return { matches, truncated };
  }
}
