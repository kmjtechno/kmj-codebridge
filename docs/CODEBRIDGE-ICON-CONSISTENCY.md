# CodeBridge plugin icon consistency

The repository's existing **CodeBridge-specific** `plugin/assets/icon.png` is the canonical square app icon for supported plugin UI fields. This is not the KMJ Main Platform favicon and is not a new or regenerated logo.

The ChatGPT plugin manifest previously used `assets/logo.png` for `logo` / `logoDark`, but `assets/icon.png` for `composerIcon` / `composerIconDark`. These files have different Git blob IDs. All four fields now reference `assets/icon.png`. The Claude plugin's directory icon already uses that same file. The original `logo.png` remains packaged for documentation and compatibility; its bytes are not overwritten.

`tests/branding-consistency.test.js` checks all supported manifest references, byte-for-byte equality of the OpenAI and Claude icon copies, valid square PNG dimensions, existing app registration ID, and preservation of the separate legacy logo.

## Platform-managed icon

The registered Apps SDK app is referenced by `plugin/.app.json` (ID `asdk_app_6abf4c8dddb08191a983c2bd9fe79732`). ChatGPT may render its **Apps** icon from the separately registered app record rather than the plugin manifest. The repository cannot read or change that platform-side image with a manifest edit. In the existing app's management UI, inspect its **App icon / Logo** setting and replace that image with the unchanged `plugin/assets/icon.png`, then save/publish or resubmit if the platform requires it. Do **not** create another app, change the ID, MCP URL, OAuth client, grants or account connections.

The MCP server supports an optional `iconUrl` which advertises `serverInfo.icons` for clients honoring MCP icon metadata. It must be an approved, publicly reachable HTTPS URL serving the same CodeBridge icon bytes; this PR deliberately does not set or deploy a production URL. MCP icon metadata does not guarantee that ChatGPT's platform-managed Apps listing uses it.

## Visual acceptance

After the repository package has been published and the existing app record's icon updated, inspect the **Plugin Details header** and **Apps** section in ChatGPT web and desktop, plus install/connection screens where supported. Confirm both display the identical official CodeBridge icon. Until that comparison is performed, the issue is **not visually verified**. No production changes are included in this PR.
