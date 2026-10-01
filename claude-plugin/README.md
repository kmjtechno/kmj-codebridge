# KMJ CodeBridge for Claude

![KMJ TECHNO](assets/logo.png)

KMJ CodeBridge lets Claude inspect authorized projects, read and update approved
files, and run administrator-configured quality gates on computers and VPSs that
you control. It is a developer preview.

## What this plugin contains

- One skill, `codebridge`, with the safety rules Claude follows when it uses the
  CodeBridge tools: inspect before editing, preserve your changes, use content
  hashes for every write, never expose secrets, and run only configured gates.
- One remote MCP server entry named `codebridge`. The plugin contains no
  executable code, hooks, scripts or bundled packages.

## What you need

This plugin does not include a hosted service. You run your own CodeBridge
gateway and device agent from https://github.com/kmjtechno/kmj-codebridge and
enter two values when you enable the plugin:

- **CodeBridge MCP endpoint**: your gateway URL ending in `/mcp`.
- **CodeBridge client token**: the client credential from your private
  CodeBridge configuration. Claude stores it in your system's secure credential
  store, not in settings files.

Claude Code can reach a local gateway such as `http://127.0.0.1:8787/mcp`.
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

The files in this plugin are provided under the Apache License 2.0 (see `LICENSE`).
Use of CodeBridge is also subject to the plugin terms in `TERMS.md`, the
privacy notice in `PRIVACY.md`, and the KMJ TECHNO
[Terms & Conditions](https://kmjtechno.com/terms),
[Privacy Policy](https://kmjtechno.com/privacy) and
[Acceptable Use Policy](https://kmjtechno.com/acceptable-use).
KMJ CodeBridge is not affiliated with or endorsed by Anthropic or OpenAI.
