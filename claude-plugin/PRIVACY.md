# KMJ CodeBridge plugin privacy notice

Last updated: 30 September 2026

This notice describes how the KMJ CodeBridge plugin for Claude and ChatGPT
handles data. The [KMJ TECHNO Privacy Policy](https://kmjtechno.com/privacy)
applies to KMJ TECHNO services generally.

## What the plugin does

The plugin contains instructions (a skill) and the address of a CodeBridge MCP
server. It contains no executable code, analytics or tracking.

## Where data goes

- The plugin connects only to the CodeBridge gateway endpoint that you or your
  administrator configure. In self-hosted deployments that gateway runs on
  infrastructure you control.
- Requests the AI assistant makes through the plugin (for example reading a
  file, searching code, Git status or running a configured quality gate) and
  your client token are sent to that gateway only.
- Results returned by your gateway (file contents, search matches, Git status,
  job logs) are shown to the AI assistant in your conversation and are then
  handled under the privacy terms of the AI provider you use.
- The plugin sends nothing to KMJ TECHNO or any other destination. KMJ TECHNO
  does not receive your source code or files through the plugin.

## Credentials

Your client token is entered when you enable the plugin and stored by the AI
client in its secure credential store. It is never written into the plugin's
files. CodeBridge redacts recognized secrets from file reads, search results and
logs before returning them.

## Licensing data

If you use a commercial CodeBridge plan, account, entitlement and license
records are processed by KMJ Main Platform under the KMJ TECHNO Privacy Policy.

## Contact

Privacy requests: see [kmjtechno.com/privacy](https://kmjtechno.com/privacy).
