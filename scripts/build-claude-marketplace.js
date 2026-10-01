// Builds the committed, self-hosted Claude Code marketplace at the repository
// root so users can run:
//   claude plugin marketplace add kmjtechno/kmj-codebridge
//   claude plugin install kmj-codebridge@kmj-techno
// No endpoint or credential is committed: Claude Code prompts each user for
// their own gateway URL and client token (stored in secure storage) at install
// time through the plugin's userConfig.
//
//   node scripts/build-claude-marketplace.js          regenerate files
//   node scripts/build-claude-marketplace.js --check  fail if files drifted
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readCanonical,
  root,
  writeClaudeMarketplace,
  writeClaudePlugin,
} from "./package-common.js";

const PLUGIN_DIR = "claude-plugin";

export const selfHostedServer = {
  type: "http",
  url: "${user_config.endpoint}",
  headers: { Authorization: "Bearer ${user_config.token}" },
};

export const selfHostedUserConfig = {
  endpoint: {
    type: "string",
    title: "CodeBridge MCP endpoint",
    description:
      "Your CodeBridge gateway URL ending in /mcp, for example https://bridge.example.com/mcp or http://127.0.0.1:8787/mcp for a local gateway.",
    required: true,
  },
  token: {
    type: "string",
    title: "CodeBridge client token",
    description:
      "The client credential from your private CodeBridge configuration (client-token.txt). Stored in your system's secure credential store.",
    sensitive: true,
    required: true,
  },
};

export const pluginReadme = `# KMJ CodeBridge for Claude

![KMJ TECHNO](assets/logo.png)

KMJ CodeBridge lets Claude inspect authorized projects, read and update approved
files, and run administrator-configured quality gates on computers and VPSs that
you control. It is a developer preview.

## What this plugin contains

- One skill, \`codebridge\`, with the safety rules Claude follows when it uses the
  CodeBridge tools: inspect before editing, preserve your changes, use content
  hashes for every write, never expose secrets, and run only configured gates.
- One remote MCP server entry named \`codebridge\`. The plugin contains no
  executable code, hooks, scripts or bundled packages.

## What you need

This plugin does not include a hosted service. You run your own CodeBridge
gateway and device agent from https://github.com/kmjtechno/kmj-codebridge and
enter two values when you enable the plugin:

- **CodeBridge MCP endpoint**: your gateway URL ending in \`/mcp\`.
- **CodeBridge client token**: the client credential from your private
  CodeBridge configuration. Claude stores it in your system's secure credential
  store, not in settings files.

Claude Code can reach a local gateway such as \`http://127.0.0.1:8787/mcp\`.
Claude on the web, desktop and mobile connect from Anthropic's cloud and need a
publicly reachable HTTPS gateway.

## Data flow

The plugin sends MCP requests, and your client token as a bearer credential,
only to the endpoint you configure. Your gateway forwards authorized requests to
your own device agent, which enforces project scope, secret-path redaction,
hash-checked writes and fixed quality-gate commands. The plugin sends nothing to
any other destination. File contents, search results, Git status and job logs
that Claude requests return from your gateway into the Claude conversation.

## Commercial terms

Plans and licensing for CodeBridge are managed by KMJ Main Platform, not by this
plugin. The plugin does not start purchases or promote upgrades.

## License and policies

The files in this plugin are provided under the Apache License 2.0 (see \`LICENSE\`).
Use of CodeBridge is also subject to the plugin terms in \`TERMS.md\`, the
privacy notice in \`PRIVACY.md\`, and the KMJ TECHNO
[Terms & Conditions](https://kmjtechno.com/terms),
[Privacy Policy](https://kmjtechno.com/privacy) and
[Acceptable Use Policy](https://kmjtechno.com/acceptable-use).
KMJ CodeBridge is not affiliated with or endorsed by Anthropic or OpenAI.
`;

export function buildInto(base) {
  const meta = readCanonical();
  writeClaudePlugin(
    path.join(base, PLUGIN_DIR),
    meta,
    selfHostedServer,
    selfHostedUserConfig,
  );
  fs.writeFileSync(path.join(base, PLUGIN_DIR, "README.md"), pluginReadme);
  writeClaudeMarketplace(base, meta, `./${PLUGIN_DIR}`);
}

function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) =>
      path
        .relative(dir, path.join(e.parentPath ?? e.path, e.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

// Compares the committed marketplace with a fresh build; returns drift list.
export function drift() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cb-marketplace-"));
  try {
    buildInto(tmp);
    const problems = [];
    for (const sub of [".claude-plugin", PLUGIN_DIR]) {
      const want = files(path.join(tmp, sub));
      const have = files(path.join(root, sub));
      for (const f of new Set([...want, ...have])) {
        const a = path.join(tmp, sub, f);
        const b = path.join(root, sub, f);
        if (!fs.existsSync(b)) problems.push(`missing ${sub}/${f}`);
        else if (!fs.existsSync(a)) problems.push(`unexpected ${sub}/${f}`);
        else if (!fs.readFileSync(a).equals(fs.readFileSync(b)))
          problems.push(`outdated ${sub}/${f}`);
      }
    }
    return problems;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("build-claude-marketplace.js")) {
  try {
    if (process.argv.includes("--check")) {
      const problems = drift();
      if (problems.length) {
        console.error(problems.join("\n"));
        console.error(
          "Claude marketplace is out of date; run npm run build:claude-marketplace.",
        );
        process.exitCode = 1;
      } else console.log("Claude marketplace matches canonical sources.");
    } else {
      fs.rmSync(path.join(root, PLUGIN_DIR), { recursive: true, force: true });
      fs.rmSync(path.join(root, ".claude-plugin"), {
        recursive: true,
        force: true,
      });
      buildInto(root);
      console.log(
        "Wrote .claude-plugin/marketplace.json and claude-plugin/. No endpoint or credential is included.",
      );
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
