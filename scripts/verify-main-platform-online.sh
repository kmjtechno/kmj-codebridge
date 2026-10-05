#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }

SERVICE="${CODEBRIDGE_MAIN_SERVICE:-kmj-codebridge-kmj-main-platform.service}"
CONFIG="${CODEBRIDGE_MAIN_CONFIG:-/etc/kmj-codebridge/agents/kmj-main-platform.json}"
STATE="${CODEBRIDGE_MAIN_STATE:-/var/lib/kmj-codebridge-kmj-main-platform}"
NODE="${CODEBRIDGE_NODE:-}"

[[ -f "$CONFIG" ]] || { echo "Missing Main Platform CodeBridge config: $CONFIG" >&2; exit 2; }

if [[ -z "$NODE" ]]; then
  if [[ -x /opt/kmj-codebridge-node/bin/node ]]; then
    NODE=/opt/kmj-codebridge-node/bin/node
  else
    NODE="$(command -v node || true)"
  fi
fi
[[ -n "$NODE" && -x "$NODE" ]] || { echo 'Node.js runtime not found.' >&2; exit 2; }

echo 'KMJ CodeBridge — Main Platform live verification'
systemctl daemon-reload
systemctl restart "$SERVICE"
sleep 2
systemctl is-active --quiet "$SERVICE"

CONFIG="$CONFIG" "$NODE" --input-type=module <<'NODE'
import fs from 'node:fs';

const file = process.env.CONFIG;
const c = JSON.parse(fs.readFileSync(file, 'utf8'));

if (!Array.isArray(c.projects) || c.projects.length !== 1) {
  throw new Error('MAIN_PLATFORM_PROJECT_COUNT_INVALID');
}
const p = c.projects[0];
if (p.id !== 'kmj-main-platform') {
  throw new Error('MAIN_PLATFORM_PROJECT_ID_INVALID');
}
if (typeof c.id !== 'string' || !c.id) {
  throw new Error('MAIN_PLATFORM_DEVICE_ID_INVALID');
}
if (typeof c.token !== 'string' || c.token.length < 32) {
  throw new Error('MAIN_PLATFORM_DEVICE_CREDENTIAL_INVALID');
}

const url = new URL('/agent/health', c.gateway);
const response = await fetch(url, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${c.token}`,
    'content-type': 'application/json',
  },
  body: '{}',
  redirect: 'error',
  signal: AbortSignal.timeout(20000),
});

if (!response.ok) {
  throw new Error(`GATEWAY_HEALTH_FAILED_HTTP_${response.status}`);
}

console.log('gateway_health=PASS');
console.log(`device_id=${c.id}`);
console.log(`tenant_id=${c.tenant}`);
console.log(`project_id=${p.id}`);
console.log(`project_root=${p.root}`);
console.log(`writable=${Boolean(p.writable)}`);
console.log(`gates=${Object.keys(p.gates ?? {}).sort().join(',')}`);
console.log(`license_mode=${c.license?.mode ?? 'unknown'}`);
NODE

echo "service_status=active"

if [[ -f "$STATE/connection.json" ]]; then
  STATE_FILE="$STATE/connection.json" "$NODE" --input-type=module <<'NODE'
import fs from 'node:fs';
const s = JSON.parse(fs.readFileSync(process.env.STATE_FILE, 'utf8'));
console.log(`agent_connected_at=${s.connectedAt ?? 'unknown'}`);
console.log(`agent_version=${s.version ?? 'unknown'}`);
NODE
else
  echo 'agent_connection_state=pending'
fi

echo 'Waiting for the gateway user-access cache window to expire...'
sleep 35

echo
echo 'MAIN_PLATFORM_AGENT_GATEWAY_VERIFIED'
echo 'Now reconnect/refresh the CodeBridge MCP client and run list_devices again.'
