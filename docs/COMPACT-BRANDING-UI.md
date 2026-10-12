# Ultra-compact work brief and opt-in KMJ brand status

`compact_work_brief({device, project})`: one user-approved read operation that aggregates three existing project-scoped reads in parallel, returning a **bounded brief rather than raw Git diff, code, prompts or task objectives**. `render_codebridge_status({device, project})` uses the same read aggregation but offers an opt-in MCP Apps UI resource. No per-tool image or widget is attached to regular tools, so the user does not pay extra visual/context overhead when only data is needed.

The branded status card uses the **existing approved icon file** at `plugin/assets/icon.png`, pinned to an immutable GitHub commit, with transparent image container. It does not regenerate the KMJ TECHNO logo, impersonate the ChatGPT platform, or claim a chat-client logo can be overridden. The UI iframe requires `raw.githubusercontent.com` in the MCP Apps resource CSP; it uses no remote JavaScript. In standard MCP clients without UI support the renderer returns a concise plain-text result. Other AI web/desktop apps must independently support MCP and, for the card, MCP Apps UI.

**This is not a token-billing waiver.** The brief restricts source/model-visible result size, reducing repeated large-context transfer; actual token saving depends on model, requests, prompts and host. `paidModelUsageEstimate` remains `NOT_MEASURED`. No automatic model execution, credential lookup, paid provider or background worker is created.

**ChatGPT installed app icon:** the existing developer-backed app `asdk_app_6ac22c9a4cc881918c59cdd9acda428f` has missing icon fields in its published app metadata. That is a separate listing-presentation issue requiring the existing app's official Manage/publishing settings; this UI resource **cannot** fix its generic app-store icon. Preserve original app identity and verified approved artwork.

**Release:** CI-green source merge alone is not deployment. Enable the new tools with an authorized signed CodeBridge gateway update. Verify that the target host renders the resource before declaring UI PASS. Do not bypass protected CI or app marketplace permissions.
