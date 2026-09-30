// Shared, vendor-neutral packaging helpers. Client-specific packagers (OpenAI,
// Claude Code) read the canonical plugin metadata and skill from `plugin/` so the
// instructions and identity cannot drift between AI clients.
import fs from "node:fs";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

export function parseArgs(argv) {
  const options = { endpoint: undefined, out: undefined, auth: undefined };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "--auth") {
      const value = argv[++i];
      if (!value) throw Error(`Missing value for ${arg}.`);
      options[arg.slice(2)] = value;
    } else if (arg.startsWith("--")) {
      throw Error(`Unknown option ${arg}.`);
    } else {
      rest.push(arg);
    }
  }
  if (rest.length > 1) throw Error("Supply exactly one MCP endpoint.");
  options.endpoint = rest[0];
  return options;
}

// Only a real, credential-free HTTPS `/mcp` endpoint may be packaged.
export function validateEndpoint(raw) {
  if (!raw)
    throw Error("Supply a real approved HTTPS MCP endpoint ending in /mcp.");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Error("Endpoint must be credential-free HTTPS /mcp.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/mcp"
  )
    throw Error("Endpoint must be credential-free HTTPS /mcp.");
  return url;
}

export function readCanonical() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "plugin/plugin.json"), "utf8"),
  );
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  );
  if (pkg.version !== manifest.version) throw Error("Version mismatch");
  return {
    name: manifest.name,
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    displayName:
      manifest.extensions?.["com.openai"]?.interface?.displayName ??
      manifest.name,
    skillsDir: path.join(root, "plugin/skills"),
  };
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

// Never delete user data: only this repository's own `dist/<name>` output is
// replaced. A custom --out directory must be new or empty. Returns the base
// directory that receives the package directory and any archive.
export function prepareOutput(custom, name) {
  if (!custom) {
    const base = path.join(root, "dist");
    fs.rmSync(path.join(base, name), { recursive: true, force: true });
    fs.rmSync(path.join(base, `${name}.tar.gz`), { force: true });
    fs.mkdirSync(base, { recursive: true });
    return base;
  }
  const base = path.resolve(custom);
  if (base === root || root.startsWith(base + path.sep))
    throw Error("Output directory must not contain the repository.");
  if (fs.existsSync(base) && fs.readdirSync(base).length)
    throw Error("Output directory must be new or empty.");
  fs.mkdirSync(base, { recursive: true });
  return base;
}
