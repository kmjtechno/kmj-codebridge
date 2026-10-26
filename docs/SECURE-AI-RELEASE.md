# Secure AI Coding — release gate

Based on the five layers and six review steps in the _Secure Vibe Coding_ guide.
This applies equally to human- and AI-authored code.

## CodeBridge checklist

| Layer                          | Mandatory evidence                                        | Existing controls                        |
| ------------------------------ | --------------------------------------------------------- | ---------------------------------------- |
| Server-side validation         | Invalid input fails closed                                | Zod schemas and bounded requests         |
| Login and API abuse resistance | Limits, authentication and scope checks                   | Gateway rate limits and MCP OAuth tests  |
| Password storage               | No new customer password store                            | Established external OAuth issuer        |
| Safe errors                    | No tokens or stack traces exposed                         | Public error mapping and secret scanning |
| Established auth               | Token identity, expiry, audience, issuer and ACL verified | src/auth.js and tests/auth.test.js       |

## Required pre-release review

1. **Dependencies:** Run npm audit --omit=dev --audit-level=high. Resolve high/critical advisories.
2. **Auth:** Run OAuth tests and confirm signed JWT subject equals the resolved identity's subject before its permissions are used.
3. **Endpoint abuse:** Test unauthenticated, expired, malformed, out-of-scope and oversized requests. A 200 MCP envelope is not proof of permission.
4. **Ownership:** Test cross-tenant, device and project authorization, including negative cases.
5. **Production config:** Check HTTPS, secure secrets, origins and error handling at deployment time.
6. **Automated plus human review:** Run npm run check, npm test and npm run scan:secrets on the exact SHA; owner review is required for sensitive changes.

Fail closed on missing evidence. Do not activate a gateway, change DNS, enroll devices or weaken device owner approvals via this change. Tests and scans do not prove live runtime security.
