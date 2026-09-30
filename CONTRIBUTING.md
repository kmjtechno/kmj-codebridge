# Contributing to KMJ CodeBridge

Thank you for helping improve KMJ CodeBridge.

## Before you start

- Use a disposable development project when testing file writes or quality gates.
- Never commit credentials, generated private configuration, customer data, or secrets.
- Keep changes focused and preserve the deny-by-default security model.
- For security vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development setup

Requires Node.js 24 and npm.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run scan:secrets
```

For changes that affect Claude packaging or interoperability, also run the relevant client/package checks documented in [docs/CLIENTS.md](docs/CLIENTS.md).

## Pull requests

1. Create a focused branch from `main`.
2. Explain the problem and the intended behavior.
3. Add or update tests for behavior changes.
4. Run the relevant quality gates.
5. Keep security boundaries and authorization checks explicit.
6. Include reproducible evidence for fixes where practical.

By intentionally submitting a contribution for inclusion in this project, you agree that it is licensed under the Apache License 2.0 as described in [LICENSE](LICENSE), unless you explicitly state otherwise in writing.

## Scope

KMJ CodeBridge is vendor-neutral. Contributions should avoid unnecessary coupling to a single AI provider, operating system, IDE, or hosting vendor unless implemented behind a clearly scoped adapter or integration boundary.
