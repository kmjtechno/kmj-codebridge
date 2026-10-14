# ChatGPT app registration values (platform-side)

The repository controls the plugin manifest (`plugin/plugin.json`), the MCP `serverInfo`
(`name`, `title`, `version`, `websiteUrl`, optional `icons`) and the canonical icon. The
**app record in OpenAI's app management UI is separate**: a stale name, developer, website,
version or icon on the app/connector page comes from that record and cannot be fixed by a
repository change. Open the existing app (ID `asdk_app_6ac22c9a4cc881918c59cdd9acda428f`)
and set the values below. Do not create a new app and do not change the ID, OAuth client or
account connections. Field labels in the UI may be worded differently from the names here.

| Field                      | Exact value                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| App / connector name       | `KMJ CodeBridge`                                                                                                                |
| Developer                  | `KMJ TECHNO`                                                                                                                    |
| Website                    | `https://kmjtechno.com`                                                                                                         |
| Connector (MCP server) URL | `https://kmjtechno.com/mcp`                                                                                                     |
| Category                   | `Developer Tools`                                                                                                               |
| Version                    | the current release in `package.json` / `product/codebridge-product.json` (`versions.stable`, currently `0.3.2`); never `1.0.0` |
| App icon / logo            | upload `plugin/assets/icon.png` unchanged                                                                                       |
| Privacy policy             | `https://kmjtechno.com/products/kmj-codebridge/privacy`                                                                         |
| Terms of service           | `https://kmjtechno.com/products/kmj-codebridge/terms`                                                                           |
| Support                    | `https://kmjtechno.com/products/kmj-codebridge/support`                                                                         |

## What the repository already guarantees

- `serverInfo` reports `name: kmj-codebridge`, `title: KMJ CodeBridge`, `version` from
  `package.json`, and `websiteUrl: https://kmjtechno.com`.
- `plugin/plugin.json` carries `displayName`, `developerName`, `category` and `websiteURL`
  matching the table, and `tests/product-metadata.test.js` ties them to
  `product/codebridge-product.json`.
- The version shown by a connector is whatever the **deployed gateway** reports. Until the
  gateway is upgraded (see `docs/DEPLOYMENT.md`), a connector refreshed against the old
  deployment can still show old values. Verify with
  `EXPECT_DEPLOYED_COMMIT=<sha> node scripts/verify-public-mcp-catalog.mjs`.

## Optional: MCP icon metadata

Set the gateway config field `iconUrl` to `https://kmjtechno.com/assets/kmj-codebridge-icon.png`
only after confirming that URL returns the same bytes as `plugin/assets/icon.png`
(`6a4489f68b93ac14fd4523fd7d692740` as MD5). It is not defaulted in code, and ChatGPT's Apps
listing may still use the registered app icon instead.

## Acceptance

Refresh the connector, then check the app page and the connector page in ChatGPT web and
desktop. Until that is observed on a real account this stays **not visually verified**.

## 2026-10-14: Activity icon and owner-provided transparent logo

The owner supplied an unchanged transparent RGBA 512x512 KMJ TECHNO PNG (SHA-256
`aaf009e628ba4f46b263fecb337ed66878a556b5ee648f8912c09ae1166c995c`).
The separately owned **classic ChatGPT Desktop plugin** was updated in place
to v0.3.3 with the uploaded original image in all four manifest icon fields:
`logo`, `logoDark`, `composerIcon`, `composerIconDark`. That release does
**not** update the independent **Apps SDK app registration** referenced by
`plugin/.app.json`.

ChatGPT's tool activity surface (for example "Interacted with GitHub") has a
distinct icon resolution path. For clients honoring the official MCP Apps
extension, entrypoint tool `icons` metadata in `tools/list` is preferred,
then the app registration icon or `serverInfo.icons`, then a generic fallback.
The CodeBridge gateway now advertises the same `iconUrl` in both
`serverInfo.icons` and the **hosted OAuth tools/list** listing's `icons` fields
**only when a deploy operator has explicitly configured a verified HTTPS PNG URL**.
The bundled MCP SDK v1.31 drops tool icons in its generic non-OAuth
`registerTool` tools/list handler; the CodeBridge hosted OAuth override has an
explicit implementation and integration test for the actual ChatGPT-facing
path. Generic non-OAuth clients may still rely on `serverInfo.icons`. No default production
URL is manufactured. A URL can identify the CodeBridge server without altering
OAuth, tenant grants or model use.

**Required to make the screenshot's ChatGPT activity use the supplied logo:**
in the **existing** Apps SDK app's Settings → Apps → Manage/Edit details (where
supported), update the app's **logo/icon** using the owner's original PNG.
Do not delete/recreate the app or replace its `asdk_app_...` identity.
If the account has no "Edit icon" control, report the host UI limitation
rather than asserting that a plugin manifest update changed platform UI.
Host app registration cannot be mutated by Plugin Creator's normal
app-backed plugin update interface because that preserves presentation.

When independently publishing a public HTTPS icon URL, compare its downloaded
SHA-256 against the **owner-supplied** checksum above, not against an unrelated
KMJ Main Platform favicon or a previously packaged CodeBridge icon. Only then
set the operator's `iconUrl` in the approved gateway config, validate
`initialize` and `tools/list` icon metadata on the live `/mcp` endpoint,
refresh the existing ChatGPT app connection and inspect a real tool activity
entry. Clients can ignore even spec-compliant MCP icons; **visual PASS**
requires a real screenshot on web/desktop. If absent, mark BLOCKED_BY_HOST_UI.

**Release distinction:** desktop plugin icon v0.3.3 UPDATED, Apps SDK app icon
UNVERIFIED, production gateway `iconUrl` UNVERIFIED, screenshot activity
UNVERIFIED. Source-only MCP metadata improvement is not a production cutover.
