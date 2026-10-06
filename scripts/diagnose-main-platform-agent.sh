#!/usr/bin/env bash
# Read-only, secret-free diagnosis of the *new* KMJ Main Platform agent.
# Never restarts services, changes project1, or rotates credentials.
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || {
  echo "ERROR=RUN_AS_ROOT" >&2
  exit 1
}

SERVICE="${CODEBRIDGE_MAIN_SERVICE:-kmj-codebridge-kmj-main-platform.service}"
NEW_CONFIG="/etc/kmj-codebridge-main-platform/agent.json"
OLD_CONFIG="/etc/kmj-codebridge/agents/kmj-main-platform.json"
CONFIG="${CODEBRIDGE_MAIN_CONFIG:-}"
STATE="${CODEBRIDGE_MAIN_STATE:-/var/lib/kmj-codebridge-kmj-main-platform}"
EXPECTED_PROJECT="kmj-main-platform"
NODE="${CODEBRIDGE_NODE:-}"

echo "KMJ CodeBridge — Main Platform Connection Doctor"
echo "mode=READ_ONLY"
echo "legacy_project1=UNTOUCHED"
echo "service=$SERVICE"

if [[ -z "$CONFIG" ]]; then
  if [[ -f "$NEW_CONFIG" ]]; then
    CONFIG="$NEW_CONFIG"
  elif [[ -f "$OLD_CONFIG" ]]; then
    CONFIG="$OLD_CONFIG"
  else
    echo "config_status=NOT_FOUND"
    echo "next_action=CHECK_MAIN_PLATFORM_AGENT_INSTALLATION"
    exit 2
  fi
fi
if [[ ! -f "$CONFIG" || -L "$CONFIG" ]]; then
  echo "config_status=UNSAFE_OR_MISSING"
  exit 2
fi
if [[ -f "$NEW_CONFIG" && -f "$OLD_CONFIG" ]]; then
  echo "config_warning=MULTIPLE_CONFIGS_CHECK_SYSTEMD_EXECSTART"
fi
echo "config_path=$CONFIG"

STATUS="$(systemctl is-active "$SERVICE" 2>/dev/null || true)"
echo "service_status=${STATUS:-unknown}"
SERVICE_USER="$(systemctl show "$SERVICE" -p User --value 2>/dev/null || true)"
[[ -n "$SERVICE_USER" ]] || SERVICE_USER="root"
echo "service_user=$SERVICE_USER"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  echo "service_user_status=MISSING"
  exit 2
fi
if ! runuser -u "$SERVICE_USER" -- test -r "$CONFIG"; then
  echo "config_access=DENIED_TO_SERVICE_USER"
else
  echo "config_access=PASS"
fi

if [[ -z "$NODE" ]]; then
  if [[ -x /opt/kmj-codebridge-node/bin/node ]]; then
    NODE=/opt/kmj-codebridge-node/bin/node
  else
    NODE="$(command -v node || true)"
  fi
fi
if [[ -z "$NODE" || ! -x "$NODE" ]]; then
  echo "node_runtime=UNAVAILABLE"
  exit 2
fi
if runuser -u "$SERVICE_USER" -- test -x "$NODE"; then
  echo "node_access=PASS"
else
  echo "node_access=DENIED_TO_SERVICE_USER"
fi

# Never print or persist c.token; send it only to canonical HTTPS endpoints.
CONFIG="$CONFIG" STATE="$STATE" EXPECTED_PROJECT="$EXPECTED_PROJECT" "$NODE" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

function report(key, value) {
  const printable = String(value).replace(/[^A-Za-z0-9_.:\/-]/g, "_").slice(0, 256);
  process.stdout.write(key + "=" + printable + "\n");
}

(async () => {
  const c = JSON.parse(fs.readFileSync(process.env.CONFIG, "utf8"));
  const projects = Array.isArray(c.projects) ? c.projects : [];
  const requested = process.env.EXPECTED_PROJECT;
  const project = projects.find((p) => p && p.id === requested);
  report("configured_device_id", c.id || "MISSING");
  report("configured_tenant_id", c.tenant || "MISSING");
  report("configured_projects", projects.map((p) => p.id).join(",") || "NONE");
  if (!project) {
    report("project_identity", "MAIN_PLATFORM_PROJECT_NOT_CONFIGURED");
    report("next_action", "REPAIR_MAIN_PLATFORM_AGENT_CONFIG_ONLY");
    process.exitCode = 2;
    return;
  }
  if (projects.some((p) => p.id === "project1")) {
    report("project_identity", "CONFIG_MIXES_LEGACY_PROJECT1");
    report("next_action", "DO_NOT_CHANGE_PROJECT1_CHECK_AGENT_CONFIG");
    process.exitCode = 2;
    return;
  }
  report("project_identity", "PASS");

  if (!fs.existsSync(project.root)) {
    report("project_root", "MISSING");
  } else if (!fs.existsSync(path.join(project.root, ".git"))) {
    report("project_root", "NO_GIT_CHECKOUT");
  } else {
    report("project_root", "PRESENT");
  }

  const marker = path.join(process.env.STATE, "connection.json");
  if (fs.existsSync(marker)) {
    try {
      const state = JSON.parse(fs.readFileSync(marker, "utf8"));
      report("last_agent_connected_at", state.connectedAt || "UNKNOWN");
    } catch {
      report("last_agent_connected_at", "STATE_UNREADABLE");
    }
  } else {
    report("last_agent_connected_at", "NEVER_RECORDED");
  }

  if (
    typeof c.token !== "string" || c.token.length < 32 ||
    typeof c.id !== "string" || !c.id ||
    typeof c.tenant !== "string" || !c.tenant
  ) {
    report("credential_status", "INVALID_LOCAL_CONFIG");
    process.exitCode = 2;
    return;
  }
  report("credential_status", "LOCALLY_PRESENT");

  const request = async (url) => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: "Bearer " + c.token,
          "content-type": "application/json",
        },
        body: "{}",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
      const text = await response.text();
      let data = {};
      try { data = JSON.parse(text); } catch {}
      return { status: response.status, data };
    } catch {
      return { status: 0, data: {} };
    }
  };

  let gateway;
  try {
    gateway = new URL(c.gateway);
    if (
      gateway.protocol !== "https:" ||
      gateway.username || gateway.password ||
      gateway.search || gateway.hash ||
      (gateway.pathname !== "/" && gateway.pathname !== "")
    ) throw new Error("INVALID_GATEWAY");
  } catch {
    report("gateway_config", "INVALID_HTTPS_ORIGIN");
    process.exitCode = 2;
    return;
  }

  const introspection = await request(
    "https://kmjtechno.com/api/codebridge/v1/device-credentials/introspect",
  );
  report("credential_introspection_http", introspection.status || "NETWORK_ERROR");
  if (introspection.status === 200 && introspection.data.active === true) {
    const d = introspection.data;
    const rawProjects = Array.isArray(d.projects) ? d.projects : [];
    const remoteProjects = rawProjects.map((p) =>
      typeof p === "string" ? p : p && p.id
    );
    const identityMatches = d.device_id === c.id && d.tenant_id === c.tenant;
    report("credential_identity", identityMatches ? "PASS" : "MISMATCH");
    report("remote_project_grant",
      remoteProjects.includes(requested) ? "PASS" : "MISSING");
  } else {
    report("credential_identity", "NOT_VERIFIED");
  }

  const health = await request(new URL("/agent/health", gateway).toString());
  report("gateway_agent_health_http", health.status || "NETWORK_ERROR");
  if (health.status === 200) {
    report("gateway_registration", "ACCEPTED");
    report("next_action", "RUN_CONNECTION_OVERVIEW_IN_PLUGIN");
  } else if (health.status === 401) {
    report("gateway_registration", "CREDENTIAL_REJECTED");
    report("next_action", "CHECK_DEVICE_PAIRING_AND_INTROSPECTION");
  } else {
    report("gateway_registration", "UNVERIFIED");
    report("next_action", "CHECK_GATEWAY_OR_AGENT_NETWORK");
  }
  if (health.status !== 200) process.exitCode = 2;
})().catch(() => {
  report("diagnostic_status", "LOCAL_CONFIG_OR_RUNTIME_ERROR");
  process.exitCode = 2;
});
NODE

# Count only fixed error codes. Raw journal lines, credentials, and URLs
# are deliberately never copied into this report.
if command -v journalctl >/dev/null 2>&1; then
  SIGNALS="$(journalctl -u "$SERVICE" -n 120 --no-pager -o cat 2>/dev/null |
    grep -Eo 'GATEWAY_REQUEST_FAILED|EACCES|ENOENT|203/EXEC|401 Unauthorized|CODEBRIDGE_CREDENTIAL_[A-Z_]+' |
    sort | uniq -c || true)"
  if [[ -n "$SIGNALS" ]]; then
    echo "recent_error_signals:"
    printf '%s\n' "$SIGNALS"
  else
    echo "recent_error_signals=NONE_MATCHED"
  fi
fi

echo "oauth_reconnection=NOT_REQUIRED_FOR_THIS_TEST"
