const CODE_LANGUAGES = new Map([
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

const SYMBOL_PATTERNS = [
  ["function", /(?:^|\s)(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/],
  ["function", /^\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/],
  ["class", /(?:^|\s)(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/],
  ["type", /(?:^|\s)(?:export\s+)?(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/],
  ["function", /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/],
  ["class", /^\s*class\s+([A-Za-z_]\w*)\b/],
  ["function", /\bfunction\s+([A-Za-z_]\w*)\s*\(/],
  ["function", /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/],
  ["type", /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/],
  ["function", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*\(/],
  ["type", /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)\b/],
  ["type", /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open)\s+)*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)\b/],
];

export const REPO_INTELLIGENCE_ADAPTER = "bounded-lexical-v1";

export function languageForExtension(extension) {
  return CODE_LANGUAGES.get(extension.toLowerCase()) ?? null;
}

export function extractLexicalSymbols(content, maxSymbols = 50) {
  const symbols = [];
  const seen = new Set();
  for (const [index, line] of content.split("\n").entries()) {
    for (const [kind, pattern] of SYMBOL_PATTERNS) {
      const match = line.match(pattern);
      const name = match?.[1];
      if (!name || seen.has(name)) continue;
      seen.add(name);
      symbols.push({ kind, name, line: index + 1 });
      if (symbols.length >= maxSymbols) return symbols;
    }
  }
  return symbols;
}

export function findIdentifierLocations(content, identifier, maxResults = 200) {
  const escaped = identifier.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    "(^|[^A-Za-z0-9_$])(" + escaped + ")(?![A-Za-z0-9_$])",
    "g",
  );
  const results = [];
  for (const [index, line] of content.split("\n").entries()) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(line))) {
      const column = match.index + match[1].length + 1;
      results.push({ line: index + 1, column });
      if (results.length >= maxResults) return results;
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
  return results;
}
