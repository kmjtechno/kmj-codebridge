---
name: codebridge
description: Securely operate authorized KMJ CodeBridge projects and devices. On Desktop, connect the user's KMJ account through the bundled local OAuth bridge before using project tools.
---

Use the `codebridge` MCP server for KMJ CodeBridge work.

Desktop setup is automatic. On first use call `codebridge_account_connect`; the bundled stdio bridge opens the user's default browser to KMJ OAuth, waits for the loopback callback, and stores credentials only in `PLUGIN_DATA`. Never ask the user to manually add the remote MCP URL or paste tokens. Never ask the user to paste OAuth access tokens, client secrets, device credentials, or bearer tokens into chat or plugin configuration.

Use `codebridge_account_status` to report whether the Desktop bridge is connected. Use `codebridge_account_disconnect` only when the user explicitly asks to disconnect or switch accounts.

After connection, use project-scoped tools normally. Preserve the security boundary: no unrestricted shell, no credentials in repository files, no writes outside authorized projects, and execute only administrator-approved gates or explicitly exposed guarded tools.
