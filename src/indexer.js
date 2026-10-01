import fs from "node:fs";
import path from "node:path";

const skippedDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".ssh",
  ".aws",
  ".azure",
  ".kube",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "target",
]);
const extensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".php",
  ".py",
  ".rs",
  ".go",
]);
const deniedName =
  /(^\.env($|\.)|credential|secret|token|id_(rsa|ed25519)|\.(pem|key|p12|pfx|keystore)$)/i;

function classify(ext, line) {
  const rules =
    ext === ".py"
      ? [
          ["class", /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
          ["function", /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/],
        ]
      : ext === ".php"
        ? [
            ["class", /^\s*(?:abstract\s+|final\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\b/i],
            ["interface", /^\s*interface\s+([A-Za-z_][A-Za-z0-9_]*)\b/i],
            ["trait", /^\s*trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/i],
            ["function", /^\s*(?:public|protected|private|static|final|abstract|\s)*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i],
          ]
        : ext === ".rs"
          ? [
              ["function", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/],
              ["struct", /^\s*(?:pub\s+)?struct\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
              ["enum", /^\s*(?:pub\s+)?enum\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
              ["trait", /^\s*(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)\b/],
            ]
          : ext === ".go"
            ? [
                ["function", /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/],
                ["type", /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+/],
              ]
            : [
                ["class", /^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/],
                ["function", /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/],
                ["interface", /^\s*(?:export\s+)?interface\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/],
                ["type", /^\s*(?:export\s+)?type\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/],
                ["enum", /^\s*(?:export\s+)?enum\s+([A-Za-z_$][A-Za-z0-9_$]*)\b/],
                ["function", /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/],
              ];
  for (const [kind, regex] of rules) {
    const match = line.match(regex);
    if (match) return { kind, name: match[1] };
  }
  return null;
}

function extract(relative, content) {
  const ext = path.extname(relative).toLowerCase();
  if (!extensions.has(ext)) return [];
  const symbols = [];
  for (const [index, line] of content.split("\n").entries()) {
    const symbol = classify(ext, line);
    if (!symbol) continue;
    symbols.push({
      ...symbol,
      path: relative,
      line: index + 1,
      signature: line.trim().slice(0, 300),
    });
    if (symbols.length >= 1000) break;
  }
  return symbols;
}

export class ProjectIndex {
  constructor(files) {
    this.files = files;
    this.cache = new Map();
    this.lastScanMs = 0;
    this.truncated = false;
    this.scannedFiles = 0;
    this.scannedBytes = 0;
  }

  refresh() {
    const started = Date.now();
    const seen = new Set();
    let visited = 0;
    let bytes = 0;
    let truncated = false;

    const walk = (absolute, relative, depth) => {
      if (depth > 12 || visited >= 1500 || bytes >= 16 * 1024 * 1024) {
        truncated = true;
        return;
      }
      let entries;
      try {
        entries = fs.readdirSync(absolute, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (visited >= 1500 || bytes >= 16 * 1024 * 1024) {
          truncated = true;
          break;
        }
        if (
          skippedDirectories.has(entry.name) ||
          deniedName.test(entry.name) ||
          entry.isSymbolicLink()
        )
          continue;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        const abs = path.join(absolute, entry.name);
        if (entry.isDirectory()) {
          walk(abs, rel, depth + 1);
          continue;
        }
        if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase()))
          continue;
        visited++;
        let stat;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 262144) continue;
        bytes += stat.size;
        seen.add(rel);
        const cached = this.cache.get(rel);
        if (
          cached &&
          cached.size === stat.size &&
          cached.mtimeMs === stat.mtimeMs
        )
          continue;
        try {
          const file = this.files.read(rel);
          this.cache.set(rel, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            symbols: extract(rel, file.content),
          });
        } catch {
          this.cache.delete(rel);
        }
      }
    };

    walk(this.files.root, "", 0);
    for (const key of this.cache.keys())
      if (!seen.has(key)) this.cache.delete(key);

    this.lastScanMs = Date.now() - started;
    this.truncated = truncated;
    this.scannedFiles = visited;
    this.scannedBytes = bytes;
  }

  search(query, kind) {
    this.refresh();
    const needle = query.toLowerCase();
    const matches = [];
    for (const record of this.cache.values()) {
      for (const symbol of record.symbols) {
        if (
          symbol.name.toLowerCase().includes(needle) &&
          (!kind || symbol.kind === kind)
        )
          matches.push(symbol);
        if (matches.length >= 200)
          return { matches, truncated: true, ...this.status() };
      }
    }
    return { matches, truncated: this.truncated, ...this.status() };
  }

  status() {
    let symbols = 0;
    for (const record of this.cache.values()) symbols += record.symbols.length;
    return {
      indexedFiles: this.cache.size,
      symbols,
      scanMs: this.lastScanMs,
      scannedFiles: this.scannedFiles,
      scannedBytes: this.scannedBytes,
      indexTruncated: this.truncated,
    };
  }
}
