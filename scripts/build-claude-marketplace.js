// Builds the committed KMJ-hosted Claude plugin marketplace at the repository
// root. The public plugin uses the production OAuth MCP endpoint and contains no
// credential. Self-hosted operators can still generate an endpoint-specific
// package with scripts/package-claude.js.
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

export const hostedServer = {
  type: "http",
  url: "https://kmjtechno.com/mcp",
};

export const pluginReadme = `# KMJ CodeBridge for Claude

![KMJ TECHNO](assets/logo.png)

KMJ CodeBridge connects Claude to projects on computers and VPSs you explicitly
authorize. The public plugin uses KMJ TECHNO's OAuth-protected MCP endpoint at
\`https://kmjtechno.com/mcp\`; it contains no API key, bearer token, or device
credential.

## What this plugin contains

- One \`codebridge\` skill with the shared safety rules used across supported
  AI clients.
- One remote Streamable HTTP MCP server named \`codebridge\`.
- Branding, license, privacy, and terms files.

## Connect

Enable the plugin and choose **Connect**. Claude discovers the OAuth
authorization server from the MCP protected-resource metadata and opens the KMJ
account-linking flow. Only devices/projects authorized for that account are
exposed.

Claude Desktop installations using a third-party inference **Gateway** profile
manage remote MCP servers in **Inference configuration → Connectors**. In that
mode add \`https://kmjtechno.com/mcp\` as a Streamable HTTP server and use
OAuth auto-registration; the account-level plugin Connect control may be
unavailable in that deployment profile. If a previously working connector gets
stuck on \`invalid_client\`, edit or re-add it, choose **Use your own OAuth
client**, set Client ID to \`kmj_codebridge_claude\`, and leave the client secret
blank. The fixed client remains PKCE-only and is bound to Claude's hosted callback.

## Self-hosted deployments

The repository remains self-hostable. Operators who run their own gateway should
generate an endpoint-specific Claude package instead of editing this public
plugin:

\`npm run package:claude -- https://YOUR-HOST/mcp\`

For static bearer developer deployments use the documented \`bearer-env\`
mode; never embed a credential in a plugin archive.

## Data flow

Claude sends MCP tool calls to the configured CodeBridge gateway. CodeBridge
routes authorized work to the outbound device agent, which enforces project
scope, guarded writes, secret redaction, and administrator-defined quality
gates. Tool results return to the Claude conversation.

## Commercial terms

Plans and licensing are controlled by KMJ Main Platform. The plugin does not
silently create a subscription or place credentials in source control.

## License and policies

The plugin files are Apache-2.0 licensed. Hosted-service use is also subject to
\`TERMS.md\`, \`PRIVACY.md\`, and the policies published by KMJ TECHNO.
KMJ CodeBridge is not affiliated with or endorsed by Anthropic or OpenAI.
`;

export function buildInto(base) {
  const meta = readCanonical();
  writeClaudePlugin(path.join(base, PLUGIN_DIR), meta, hostedServer);
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
        "Wrote .claude-plugin/marketplace.json and claude-plugin/ for the KMJ-hosted OAuth endpoint. No credential is included.",
      );
    }
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
