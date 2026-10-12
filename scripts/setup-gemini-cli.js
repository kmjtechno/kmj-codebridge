#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateEndpoint } from "./package-common.js";

const DEFAULT_ENDPOINT = "https://kmjtechno.com/mcp";
const SERVER = "kmj-codebridge";
const MAX_BYTES = 1024 * 1024;

function usage() {
  throw Error(
    "Usage: node scripts/setup-gemini-cli.js [--scope user|project] " +
      "[--endpoint https://host/mcp] [--dry-run|--check|--yes]",
  );
}

function parseArgs(argv) {
  let scope = "user";
  let endpoint = DEFAULT_ENDPOINT;
  let mode = "dry-run";
  let seenMode = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--scope" || arg === "--endpoint") {
      const value = argv[++i];
      if (!value) usage();
      if (arg === "--scope") {
        if (!["user", "project"].includes(value)) usage();
        scope = value;
      } else {
        endpoint = value;
      }
    } else if (["--yes", "--dry-run", "--check"].includes(arg)) {
      if (seenMode) usage();
      seenMode = true;
      mode = arg.slice(2);
    } else usage();
  }
  return { scope, endpoint: validateEndpoint(endpoint).href, mode };
}

function safeFile(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw Error("GEMINI_CONFIG_UNSAFE");
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES)
    throw Error("GEMINI_CONFIG_UNSAFE");
  return true;
}

function safeDir(dir, write) {
  let stat;
  try {
    stat = fs.lstatSync(dir);
  } catch (error) {
    if (error.code !== "ENOENT") throw Error("GEMINI_DIRECTORY_UNSAFE");
    if (!write) return false;
    fs.mkdirSync(dir, { mode: 0o700 });
    stat = fs.lstatSync(dir);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw Error("GEMINI_DIRECTORY_UNSAFE");
  return true;
}

function readConfig(file) {
  if (!safeFile(file)) return { raw: null, config: {} };
  const raw = fs.readFileSync(file, "utf8");
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    throw Error("GEMINI_CONFIG_INVALID_JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw Error("GEMINI_CONFIG_INVALID_JSON");
  if (
    config.mcpServers !== undefined &&
    (!config.mcpServers ||
      typeof config.mcpServers !== "object" ||
      Array.isArray(config.mcpServers))
  ) throw Error("GEMINI_MCP_SERVERS_INVALID");
  return { raw, config };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const home = process.platform === "win32"
    ? (process.env.USERPROFILE || os.homedir())
    : os.homedir();
  const base = options.scope === "user" ? home : fs.realpathSync(process.cwd());
  const folder = path.join(base, ".gemini");
  const target = path.join(folder, "settings.json");

  const hasDir = safeDir(folder, false);
  const { raw, config } = hasDir ? readConfig(target) : { raw: null, config: {} };
  const existing = config.mcpServers?.[SERVER];
  const intended = { httpUrl: options.endpoint, trust: false };
  const matching = existing && Object.keys(existing).length === 2 &&
    existing.httpUrl === intended.httpUrl && existing.trust === false;

  if (existing && !matching)
    throw Error("GEMINI_CODEBRIDGE_ALREADY_CONFIGURED_DIFFERENTLY");

  if (options.mode === "check") {
    if (!matching) throw Error("GEMINI_CODEBRIDGE_NOT_CONFIGURED");
    console.log("GEMINI_CODEBRIDGE_CONFIGURED: remote HTTP OAuth; confirmations enabled");
    return;
  }
  if (matching) {
    console.log("GEMINI_CODEBRIDGE_ALREADY_CONFIGURED");
    return;
  }
  if (options.mode === "dry-run") {
    console.log("GEMINI_CODEBRIDGE_DRY_RUN: would add remote HTTP OAuth without credentials");
    console.log("Scope: " + options.scope);
    console.log("Apply with --yes after reviewing this scope.");
    return;
  }

  // An explicit --yes is mandatory. Never alter an existing CodeBridge entry,
  // even if another assistant previously placed static tokens in that entry.
  safeDir(folder, true);
  const latest = readConfig(target);
  if (latest.raw !== raw) throw Error("GEMINI_CONFIG_CHANGED_DURING_SETUP");
  const merged = {
    ...config,
    mcpServers: { ...(config.mcpServers ?? {}), [SERVER]: intended },
  };
  const data = JSON.stringify(merged, null, 2) + "\n";
  const temp = path.join(folder, ".kmj-gemini-" + randomUUID() + ".tmp");
  let backup = null;
  try {
    if (raw !== null) {
      backup = path.join(folder, "settings.json.before-kmj-" + randomUUID() + ".bak");
      fs.writeFileSync(backup, raw, { flag: "wx", mode: 0o600 });
    }
    fs.writeFileSync(temp, data, { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, target);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
  console.log("GEMINI_CODEBRIDGE_CONFIGURED: remote HTTP OAuth; confirmations enabled");
  console.log("Scope: " + options.scope);
  console.log(backup ? "Existing settings preserved in a private backup." : "New settings file created.");
  console.log("Open Gemini CLI or Gemini Code Assist Agent mode; use /mcp, then OAuth sign-in.");
  console.log("This does not configure the consumer Gemini web/desktop apps.");
}

try {
  main();
} catch (error) {
  console.error("KMJ_GEMINI_SETUP_BLOCKED: " + error.message);
  process.exitCode = 1;
}
