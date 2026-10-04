# KMJ CodeBridge plugin privacy notice

Last updated: 4 October 2026

Canonical hosted privacy policy: https://kmjtechno.com/products/kmj-codebridge/privacy

This notice explains the CodeBridge plugin data path. The privacy terms displayed by KMJ TECHNO at account creation or checkout govern any hosted KMJ service.

## What the plugin does

The plugin provides instructions, branding and the address of a CodeBridge MCP gateway. It does not need to contain customer source code or long-lived device secrets.

## Where project data goes

- In **self-hosted mode**, requests are sent to the CodeBridge gateway configured by the user or administrator.
- In a **KMJ-hosted mode**, requests are sent to KMJ TECHNO’s configured CodeBridge gateway so that they can be routed to the customer’s authorized device agent.
- Tool results requested by the AI client—such as file excerpts, search matches, Git state or quality-gate output—are returned to that AI client and may therefore be processed by the AI provider under that provider’s own terms.
- CodeBridge is designed to return only data requested through its bounded tool contract and configured project scope.

## Credentials

Client and device credentials should be stored in the appropriate private credential/configuration stores, not committed to source repositories or pasted into conversations. CodeBridge hashes configured static credentials at the gateway where applicable and supports scoped authentication patterns described in the documentation.

## Redaction and minimization

Recognized secrets are redacted from supported reads, searches and logs before tool results are returned. Redaction is a safety layer, not a guarantee that arbitrary sensitive data can never appear. Customers must keep secrets outside model-accessible project content wherever possible.

## Commercial account data

If you use a KMJ-hosted or paid plan, KMJ Main Platform may process account identity, organization, entitlement, device-registration, billing, support, fraud-prevention and service-operation records needed to provide the service.

## Retention

Retention for KMJ-hosted account, billing, support and service-operation data must follow the privacy policy presented by KMJ TECHNO. Self-hosted deployments are controlled by their own operator.

## Your responsibilities

Do not connect projects or data that you are not authorized to process. Review the privacy and data-use settings of the AI provider you connect to CodeBridge.

## Contact

Use the privacy contact route published by KMJ TECHNO for hosted-service privacy requests.
