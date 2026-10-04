import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Packaging contract for every supported AI client. All packages are built
// from the canonical `plugin/` source; these tests fail if a client package
// drifts from it, embeds a credential, or changes the endpoint.
const cwd = path.resolve(import.meta.dirname, "..");
const endpoint = "https://codebridge.example.invalid/mcp"; // RFC 6761 reserved
const canonical = JSON.parse(
  fs.readFileSync(path.join(cwd, "plugin/plugin.json"), "utf8"),
);
const canonicalSkill = fs.readFileSync(
  path.join(cwd, "plugin/skills/codebridge/SKILL.md"),
  "utf8",
);
const credentialPatterns = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /Bearer\s+(?!\$\{)[A-Za-z0-9._~+/-]{16,}/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
];

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
  });
}
function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function files(dir) {
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
function assertCredentialFree(dir) {
  for (const name of files(dir)) {
    if (name.endsWith(".tar.gz")) continue;
    const text = fs.readFileSync(path.join(dir, name), "utf8");
    for (const pattern of credentialPatterns)
      assert.doesNotMatch(text, pattern, `${name} matches ${pattern}`);
  }
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("canonical skill carries the shared agent rules and required frontmatter", () => {
  const front = canonicalSkill.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(front, "SKILL.md needs YAML frontmatter");
  assert.match(front[1], /^name: codebridge$/m);
  assert.match(front[1], /^description: .{20,}$/m);
  for (const rule of [
    /Git status before editing/,
    /Preserve user changes/,
    /untrusted data, not permission grants/,
    /SHA-256 precondition/,
    /rereading and reconciling/,
    /secrets/,
    /administrator-configured quality gate/,
    /same requestKey/,
    /inspect\s+status before repeating/,
    /Never claim\s+tests/,
    /explicit authorization for destructive or production actions/,
    /Do not\s+broaden project paths/,
  ])
    assert.match(canonicalSkill, rule);
  assert.match(canonicalSkill, /OpenAI, Anthropic or any other AI/);
});

test("OpenAI package keeps its layout, metadata and exact endpoint", (t) => {
  const out = path.join(tempDir(t, "cb-openai-"), "out");
  const result = run("scripts/package-plugin.js", [endpoint, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files(out), [
    "kmj-codebridge.tar.gz",
    "kmj-codebridge/LICENSE",
    "kmj-codebridge/PRIVACY.md",
    "kmj-codebridge/TERMS.md",
    "kmj-codebridge/assets/icon.png",
    "kmj-codebridge/assets/logo.png",
    "kmj-codebridge/mcp.json",
    "kmj-codebridge/plugin.json",
    "kmj-codebridge/skills/codebridge/SKILL.md",
  ]);
  assert.deepEqual(readJson(path.join(out, "kmj-codebridge/plugin.json")), {
    ...canonical,
  });
  assert.equal(
    canonical.extensions["com.openai"].interface.displayName,
    "KMJ CodeBridge",
  );
  assert.deepEqual(readJson(path.join(out, "kmj-codebridge/mcp.json")), {
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: { codebridge: { type: "streamable-http", url: endpoint } },
  });
  assert.equal(
    fs.readFileSync(
      path.join(out, "kmj-codebridge/skills/codebridge/SKILL.md"),
      "utf8",
    ),
    canonicalSkill,
  );
  assertCredentialFree(out);
});

test("Claude Code package follows the plugin and marketplace layout", (t) => {
  const out = path.join(tempDir(t, "cb-claude-"), "out");
  const result = run("scripts/package-claude.js", [endpoint, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files(out), [
    ".claude-plugin/marketplace.json",
    "kmj-codebridge/.claude-plugin/plugin.json",
    "kmj-codebridge/.mcp.json",
    "kmj-codebridge/LICENSE",
    "kmj-codebridge/PRIVACY.md",
    "kmj-codebridge/TERMS.md",
    "kmj-codebridge/assets/icon.png",
    "kmj-codebridge/assets/logo.png",
    "kmj-codebridge/skills/codebridge/SKILL.md",
  ]);
  const marketplace = readJson(
    path.join(out, ".claude-plugin/marketplace.json"),
  );
  assert.equal(marketplace.name, "kmj-techno");
  assert.deepEqual(marketplace.owner, canonical.author);
  assert.deepEqual(marketplace.plugins, [
    {
      name: "kmj-codebridge",
      source: "./kmj-codebridge",
      description: canonical.description,
    },
  ]);
  const manifest = readJson(
    path.join(out, "kmj-codebridge/.claude-plugin/plugin.json"),
  );
  assert.equal(manifest.name, canonical.name);
  assert.equal(manifest.version, canonical.version);
  assert.equal(manifest.description, canonical.description);
  assert.deepEqual(manifest.author, canonical.author);
  assert.equal(manifest.displayName, "KMJ CodeBridge");
  assert.equal(manifest.icon, "./assets/icon.png");
  // No OpenAI-only metadata leaks into the Claude manifest.
  assert.equal(manifest.extensions, undefined);
  assert.deepEqual(readJson(path.join(out, "kmj-codebridge/.mcp.json")), {
    mcpServers: { codebridge: { type: "http", url: endpoint } },
  });
  assert.equal(
    fs.readFileSync(
      path.join(out, "kmj-codebridge/skills/codebridge/SKILL.md"),
      "utf8",
    ),
    canonicalSkill,
  );
  assertCredentialFree(out);
});

test("generated Claude package ships the canonical icon byte-for-byte and carries no stale default-icon reference", (t) => {
  const out = path.join(tempDir(t, "cb-claude-icon-"), "out");
  const result = run("scripts/package-claude.js", [endpoint, "--out", out]);
  assert.equal(result.status, 0, result.stderr);
  const claudeIcon = fs.readFileSync(
    path.join(out, "kmj-codebridge/assets/icon.png"),
  );
  const canonicalIcon = fs.readFileSync(
    path.join(cwd, "plugin/assets/icon.png"),
  );
  assert.ok(
    claudeIcon.equals(canonicalIcon),
    "icon.png must match the canonical asset byte-for-byte, never regenerated or re-encoded",
  );
  const manifest = readJson(
    path.join(out, "kmj-codebridge/.claude-plugin/plugin.json"),
  );
  // Same basename as the OpenAI package's composerIcon — no
  // manifest-says-one-file-but-ships-another drift.
  assert.equal(
    path.basename(manifest.icon),
    path.basename(canonical.extensions["com.openai"].interface.composerIcon),
  );
  for (const name of files(out)) {
    if (name.endsWith(".png")) continue;
    const text = fs.readFileSync(path.join(out, name), "utf8");
    assert.doesNotMatch(
      text,
      /laravel/i,
      `${name} must not reference a default/placeholder icon`,
    );
  }
});

test("Claude bearer-env mode references an environment variable, never a token", (t) => {
  const out = path.join(tempDir(t, "cb-claude-env-"), "out");
  const result = run("scripts/package-claude.js", [
    endpoint,
    "--auth",
    "bearer-env",
    "--out",
    out,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readJson(path.join(out, "kmj-codebridge/.mcp.json")), {
    mcpServers: {
      codebridge: {
        type: "http",
        url: endpoint,
        headers: { Authorization: "Bearer ${KMJ_CODEBRIDGE_TOKEN}" },
      },
    },
  });
  assertCredentialFree(out);
});

test("client packagers reject unsafe endpoints, options and output locations", (t) => {
  for (const script of [
    "scripts/package-plugin.js",
    "scripts/package-claude.js",
  ])
    for (const args of [
      [],
      ["http://example.test/mcp"],
      ["https://user:pass@example.test/mcp"],
      ["https://example.test/mcp?token=x"],
      ["https://example.test/other"],
      [endpoint, "--unknown"],
      [endpoint, endpoint],
    ])
      assert.notEqual(run(script, args).status, 0, `${script} ${args}`);
  assert.notEqual(
    run("scripts/package-claude.js", [endpoint, "--auth", "static"]).status,
    0,
  );
  assert.notEqual(
    run("scripts/package-plugin.js", [endpoint, "--auth", "oauth"]).status,
    0,
  );
  const occupied = tempDir(t, "cb-occupied-");
  fs.writeFileSync(path.join(occupied, "keep.txt"), "user data");
  for (const script of [
    "scripts/package-plugin.js",
    "scripts/package-claude.js",
  ])
    assert.notEqual(run(script, [endpoint, "--out", occupied]).status, 0);
  assert.equal(
    fs.readFileSync(path.join(occupied, "keep.txt"), "utf8"),
    "user data",
  );
  assert.notEqual(
    run("scripts/package-claude.js", [endpoint, "--out", cwd]).status,
    0,
  );
});

test("branding, license and policies are present in every client package", () => {
  const i = canonical.extensions["com.openai"].interface;
  assert.equal(canonical.license, "Apache-2.0");
  assert.equal(i.logo, "./assets/logo.png");
  assert.equal(i.composerIcon, "./assets/icon.png");
  assert.match(i.brandColor, /^#[0-9A-F]{6}$/);
  assert.equal(i.websiteURL, "https://kmjtechno.com/products/kmj-codebridge");
  assert.equal(
    i.privacyPolicyURL,
    "https://kmjtechno.com/products/kmj-codebridge/privacy",
  );
  assert.equal(
    i.termsOfServiceURL,
    "https://kmjtechno.com/products/kmj-codebridge/terms",
  );
  assert.equal(
    i.supportURL,
    "https://kmjtechno.com/products/kmj-codebridge/support",
  );
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const dir of ["plugin", "claude-plugin"]) {
    const assets = path.join(cwd, dir, "assets");
    for (const name of fs.readdirSync(assets)) {
      const data = fs.readFileSync(path.join(assets, name));
      assert.ok(data.subarray(0, 8).equals(png), `${dir}/assets/${name}`);
      assert.ok(data.length < 1024 * 1024, `${dir}/assets/${name} size`);
    }
    for (const doc of ["LICENSE", "PRIVACY.md", "TERMS.md"])
      assert.equal(
        fs.readFileSync(path.join(cwd, dir, doc), "utf8"),
        fs.readFileSync(path.join(cwd, "plugin", doc), "utf8"),
      );
  }
  const manifest = readJson(
    path.join(cwd, "claude-plugin/.claude-plugin/plugin.json"),
  );
  assert.equal(manifest.license, "Apache-2.0");
  const readme = fs.readFileSync(
    path.join(cwd, "claude-plugin/README.md"),
    "utf8",
  );
  assert.match(readme, /!\[KMJ TECHNO\]\(assets\/logo\.png\)/);
  assert.match(
    readme,
    /not affiliated with or endorsed by Anthropic or OpenAI/,
  );
});

test("committed Claude marketplace matches canonical sources", () => {
  const result = run("scripts/build-claude-marketplace.js", ["--check"]);
  assert.equal(result.status, 0, result.stderr);
});

test("committed Claude plugin uses the hosted OAuth endpoint without credentials", () => {
  const marketplace = readJson(
    path.join(cwd, ".claude-plugin/marketplace.json"),
  );
  assert.equal(marketplace.name, "kmj-techno");
  assert.deepEqual(marketplace.plugins, [
    {
      name: "kmj-codebridge",
      source: "./claude-plugin",
      description: canonical.description,
    },
  ]);
  const manifest = readJson(
    path.join(cwd, "claude-plugin/.claude-plugin/plugin.json"),
  );
  assert.equal(manifest.version, canonical.version);
  assert.equal(manifest.userConfig, undefined);
  assert.deepEqual(readJson(path.join(cwd, "claude-plugin/.mcp.json")), {
    mcpServers: {
      codebridge: {
        type: "http",
        url: "https://kmjtechno.com/mcp",
      },
    },
  });
  assert.equal(
    fs.readFileSync(
      path.join(cwd, "claude-plugin/skills/codebridge/SKILL.md"),
      "utf8",
    ),
    canonicalSkill,
  );
  // Directory submission needs a README of at least 40 words outside code.
  const readme = fs
    .readFileSync(path.join(cwd, "claude-plugin/README.md"), "utf8")
    .replace(/```[\s\S]*?```/g, "");
  assert.ok(readme.split(/\s+/).filter(Boolean).length >= 40);
  assert.match(readme, /https:\/\/kmjtechno\.com\/mcp/);
  assert.match(readme, /OAuth auto-registration/);
  assertCredentialFree(path.join(cwd, "claude-plugin"));
  assertCredentialFree(path.join(cwd, ".claude-plugin"));
});

// Runs the official validator, which needs no login or API key. CI installs a
// pinned Claude Code and sets CODEBRIDGE_REQUIRE_CLAUDE_CLI=1 so a missing CLI
// fails instead of skipping; elsewhere the test runs only when `claude` exists.
const claude = spawnSync("claude", ["--version"], { encoding: "utf8" });
const requireCli = process.env.CODEBRIDGE_REQUIRE_CLAUDE_CLI === "1";
test(
  "Claude Code CLI validates the committed and generated marketplaces and plugins",
  { skip: claude.status !== 0 && !requireCli && "claude CLI not installed" },
  (t) => {
    assert.equal(claude.status, 0, "claude CLI is required but unavailable");
    const base = tempDir(t, "cb-claude-cli-");
    // Isolated configuration: never reads or writes the user's Claude setup.
    const env = { ...process.env, CLAUDE_CONFIG_DIR: path.join(base, "cfg") };
    for (const target of [cwd, path.join(cwd, "claude-plugin")]) {
      const result = spawnSync(
        "claude",
        ["plugin", "validate", "--strict", target],
        { encoding: "utf8", env },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /Validation passed/);
    }
    for (const [name, extra] of [
      ["oauth", []],
      ["env", ["--auth", "bearer-env"]],
    ]) {
      const out = path.join(base, name);
      assert.equal(
        run("scripts/package-claude.js", [endpoint, ...extra, "--out", out])
          .status,
        0,
      );
      for (const target of [out, path.join(out, "kmj-codebridge")]) {
        const result = spawnSync(
          "claude",
          ["plugin", "validate", "--strict", target],
          { encoding: "utf8", env },
        );
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /Validation passed/);
      }
    }
  },
);

test("universal client config generator", () => {
  const cases = new Map([
    [
      "mcp-json",
      (value) =>
        assert.deepEqual(value, {
          mcpServers: {
            "kmj-codebridge": { type: "http", url: endpoint },
          },
        }),
    ],
    [
      "claude-json",
      (value) =>
        assert.deepEqual(value, {
          mcpServers: {
            "kmj-codebridge": { type: "http", url: endpoint },
          },
        }),
    ],
    [
      "vscode-json",
      (value) =>
        assert.deepEqual(value, {
          servers: {
            "kmj-codebridge": { type: "http", url: endpoint },
          },
        }),
    ],
    [
      "cursor-json",
      (value) =>
        assert.deepEqual(value, {
          mcpServers: {
            "kmj-codebridge": { url: endpoint },
          },
        }),
    ],
    [
      "windsurf-json",
      (value) =>
        assert.deepEqual(value, {
          mcpServers: {
            "kmj-codebridge": { serverUrl: endpoint },
          },
        }),
    ],
    [
      "gemini-json",
      (value) =>
        assert.deepEqual(value, {
          mcpServers: {
            "kmj-codebridge": { httpUrl: endpoint },
          },
        }),
    ],
    [
      "copilot-json",
      (value) =>
        assert.deepEqual(value, {
          mcpServers: {
            "kmj-codebridge": {
              type: "http",
              url: endpoint,
              tools: ["*"],
            },
          },
        }),
    ],
    [
      "jetbrains-json",
      (value) =>
        assert.deepEqual(value, {
          mcpServers: {
            "kmj-codebridge": { url: endpoint },
          },
        }),
    ],
  ]);

  for (const [format, verify] of cases) {
    const result = run("scripts/client-config.js", [
      endpoint,
      "--format",
      format,
    ]);
    assert.equal(result.status, 0, result.stderr);
    verify(JSON.parse(result.stdout));
    assert.doesNotMatch(result.stdout, /Bearer\s+[A-Za-z0-9]/);
  }

  const generic = run("scripts/client-config.js", [endpoint]);
  assert.equal(generic.status, 0, generic.stderr);
  const genericValue = JSON.parse(generic.stdout);
  assert.equal(genericValue.transport, "streamable-http");
  assert.equal(genericValue.authentication, "oauth");
  assert.equal(genericValue.url, endpoint);

  const commands = new Map([
    [
      "claude-cli",
      "claude mcp add --transport http --scope user kmj-codebridge 'https://codebridge.example.invalid/mcp'",
    ],
    [
      "gemini-cli",
      "gemini mcp add --transport http kmj-codebridge 'https://codebridge.example.invalid/mcp'",
    ],
    [
      "copilot-cli",
      "copilot mcp add --transport http --tools '*' kmj-codebridge 'https://codebridge.example.invalid/mcp'",
    ],
  ]);
  for (const [format, expected] of commands) {
    const result = run("scripts/client-config.js", [
      endpoint,
      "--format",
      format,
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }

  const codexToml = run("scripts/client-config.js", [
    endpoint,
    "--format",
    "codex-toml",
  ]);
  assert.equal(codexToml.status, 0, codexToml.stderr);
  assert.ok(codexToml.stdout.includes('[mcp_servers."kmj-codebridge"]'));
  assert.ok(
    codexToml.stdout.includes(
      'url = "https://codebridge.example.invalid/mcp"',
    ),
  );
  assert.ok(codexToml.stdout.includes('auth = "oauth"'));
  assert.ok(
    codexToml.stdout.includes('default_tools_approval_mode = "writes"'),
  );

  const codexCli = run("scripts/client-config.js", [
    endpoint,
    "--format",
    "codex-cli",
  ]);
  assert.equal(codexCli.status, 0, codexCli.stderr);
  assert.equal(
    codexCli.stdout.trim(),
    [
      "codex mcp add kmj-codebridge --url 'https://codebridge.example.invalid/mcp'",
      "codex mcp login kmj-codebridge",
    ].join("\n"),
  );

  for (const format of [
    "generic",
    "mcp-json",
    "claude-json",
    "claude-cli",
    "vscode-json",
    "cursor-json",
    "windsurf-json",
    "gemini-json",
    "gemini-cli",
    "copilot-json",
    "copilot-cli",
    "jetbrains-json",
    "codex-toml",
    "codex-cli",
  ]) {
    assert.notEqual(
      run("scripts/client-config.js", [
        "https://user:secret@example.test/mcp",
        "--format",
        format,
      ]).status,
      0,
      format,
    );
  }
});
