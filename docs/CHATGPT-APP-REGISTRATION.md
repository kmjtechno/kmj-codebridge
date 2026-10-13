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
