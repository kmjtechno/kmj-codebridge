import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fail } from "./errors.js";
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
