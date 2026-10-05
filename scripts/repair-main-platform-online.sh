#!/usr/bin/env bash
set -euo pipefail
umask 077

[[ ${EUID:-$(id -u)} -eq 0 ]] || { echo 'Run as root.' >&2; exit 1; }

SERVICE='kmj-codebridge-kmj-main-platform.service'
PROJECT='/srv/kmj-codebridge-projects/kmj-main-platform'
OLD_CONFIG='/etc/kmj-codebridge/agents/kmj-main-platform.json'
CONFIG_DIR='/etc/kmj-codebridge-main-platform'
CONFIG="$CONFIG_DIR/agent.json"
STATE='/var/lib/kmj-codebridge-kmj-main-platform'
SOURCE_RUNTIME='/opt/kmj-codebridge-agent'
RUNTIME='/opt/kmj-codebridge-main-platform-agent'
NODE='/opt/kmj-codebridge-node/bin/node'
GATEWAY="${CODEBRIDGE_GATEWAY:-https://kmj-codebridge-gateway.onrender.com}"

if [[ ! -x "$NODE" ]]; then NODE="$(command -v node || true)"; fi
[[ -n "$NODE" && -x "$NODE" ]] || { echo 'ERROR node_runtime_missing' >&2; exit 2; }
[[ -d "$PROJECT/.git" ]] || { echo 'ERROR main_platform_git_checkout_missing' >&2; exit 2; }
grep -Fq '"name": "kmjtechno/kmj-main-platform"' "$PROJECT/apps/platform/composer.json" || {
  echo 'ERROR main_platform_identity_failed' >&2; exit 2;
}

SERVICE_USER="$(systemctl show "$SERVICE" -p User --value 2>/dev/null || true)"
if [[ -z "$SERVICE_USER" ]]; then
  if id kmjprod >/dev/null 2>&1; then SERVICE_USER=kmjprod
  elif id kmjrunner >/dev/null 2>&1; then SERVICE_USER=kmjrunner
  else SERVICE_USER=root
  fi
fi
id "$SERVICE_USER" >/dev/null 2>&1 || { echo "ERROR service_user_missing=$SERVICE_USER" >&2; exit 2; }
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

echo 'KMJ CodeBridge — Main Platform auto-repair + verification'
echo "service_user=$SERVICE_USER"

[[ -d "$SOURCE_RUNTIME" && -f "$SOURCE_RUNTIME/src/cli.js" ]] || {
  echo 'ERROR source_codebridge_runtime_missing' >&2
  exit 2
}

if [[ ! -d "$RUNTIME" || ! -f "$RUNTIME/src/cli.js" ]]; then
  rm -rf "$RUNTIME"
  cp -a "$SOURCE_RUNTIME" "$RUNTIME"
  echo 'runtime_isolation=created'
else
  echo 'runtime_isolation=existing'
fi
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$RUNTIME"
chmod 0755 /opt
find "$RUNTIME" -type d -exec chmod u+rwx,go-rwx {} +
find "$RUNTIME" -type f -exec chmod u+rw,go-rwx {} +
chmod u+x "$RUNTIME/src/cli.js" 2>/dev/null || true

install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$CONFIG_DIR" "$STATE"

if [[ ! -f "$CONFIG" ]]; then
  if [[ -f "$OLD_CONFIG" ]]; then
    install -m 0600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$OLD_CONFIG" "$CONFIG"
    echo 'config_migration=done'
  else
    echo 'ERROR main_platform_agent_config_missing' >&2
    exit 2
  fi
fi
chown "$SERVICE_USER:$SERVICE_GROUP" "$CONFIG"
chmod 0600 "$CONFIG"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$STATE" "$PROJECT"

CONFIG="$CONFIG" GATEWAY="$GATEWAY" "$NODE" --input-type=module <<'NODE'
import fs from 'node:fs';
const file=process.env.CONFIG;
const c=JSON.parse(fs.readFileSync(file,'utf8'));
let valid=false;
if(typeof c.gateway==='string'){
  try{
    const u=new URL(c.gateway);
    valid=u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&(u.pathname==='/'||u.pathname==='');
  }catch{}
}
if(!valid){
  const u=new URL(process.env.GATEWAY);
  if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||!(u.pathname==='/'||u.pathname==='')){
    throw new Error('FALLBACK_GATEWAY_INVALID');
  }
  c.gateway=u.origin;
  const tmp=file+'.gateway-repair-'+process.pid;
  const fd=fs.openSync(tmp,'wx',0o600);
  try{
    fs.writeFileSync(fd,JSON.stringify(c,null,2)+'\n');
    fs.fsyncSync(fd);
  }finally{
    fs.closeSync(fd);
  }
  fs.renameSync(tmp,file);
  console.log('gateway_repair=done');
}else{
  console.log('gateway_repair=not_needed');
}
NODE

CONFIG="$CONFIG" PROJECT="$PROJECT" "$NODE" --input-type=module <<'NODE'
import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.env.CONFIG,'utf8'));
if(!Array.isArray(c.projects)||c.projects.length!==1) throw new Error('PROJECT_COUNT_INVALID');
const p=c.projects[0];
if(p.id!=='kmj-main-platform') throw new Error('PROJECT_ID_INVALID');
if(fs.realpathSync(p.root)!==fs.realpathSync(process.env.PROJECT)) throw new Error('PROJECT_ROOT_INVALID');
if(typeof c.token!=='string'||c.token.length<32) throw new Error('CREDENTIAL_INVALID');
if(typeof c.gateway!=='string'||!c.gateway.startsWith('https://')) throw new Error('GATEWAY_INVALID');
console.log('config_identity=PASS');
console.log('project_id='+p.id);
console.log('project_root='+p.root);
console.log('writable='+Boolean(p.writable));
console.log('gates='+Object.keys(p.gates??{}).sort().join(','));
console.log('device_id='+c.id);
console.log('tenant_id='+c.tenant);
NODE

cat >"/etc/systemd/system/$SERVICE" <<EOF
[Unit]
Description=KMJ CodeBridge Agent - Main Platform
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$RUNTIME
ExecStart=$NODE $RUNTIME/src/cli.js agent $CONFIG
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
ReadWritePaths=$PROJECT $STATE
UMask=0077

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"

for _ in 1 2 3 4 5; do
  sleep 1
  if systemctl is-active --quiet "$SERVICE"; then break; fi
done

if ! systemctl is-active --quiet "$SERVICE"; then
  echo 'service_status=FAILED'
  systemctl status "$SERVICE" --no-pager -l || true
  echo '--- recent journal ---'
  journalctl -u "$SERVICE" -n 40 --no-pager 2>/dev/null || true
  exit 3
fi

echo 'service_status=active'

CONFIG="$CONFIG" "$NODE" --input-type=module <<'NODE'
import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync(process.env.CONFIG,'utf8'));

async function check(url,label){
  const r=await fetch(url,{
    method:'POST',
    headers:{authorization:`Bearer ${c.token}`,'content-type':'application/json'},
    body:'{}',
    redirect:'error',
    signal:AbortSignal.timeout(20000)
  });
  if(!r.ok) throw new Error(label+'_HTTP_'+r.status);
  return r;
}

await check(new URL('/agent/health',c.gateway),'GATEWAY_HEALTH');
console.log('gateway_health=PASS');

const introspect=await check('https://kmjtechno.com/api/codebridge/v1/device-credentials/introspect','INTROSPECTION');
const data=await introspect.json();
if(data.active!==true) throw new Error('INTROSPECTION_INACTIVE');
if(!Array.isArray(data.projects)||!data.projects.includes('kmj-main-platform')) throw new Error('INTROSPECTION_PROJECT_MISSING');
console.log('credential_introspection=PASS');
console.log('introspected_device='+data.device_id);
console.log('introspected_projects='+data.projects.join(','));
console.log('introspected_permissions='+(data.permissions??[]).join(','));
NODE

echo 'visibility_cache_wait=35s'
sleep 35

echo 'MAIN_PLATFORM_AGENT_GATEWAY_VERIFIED'
echo 'Refresh/reconnect the CodeBridge MCP client, then run list_devices again.'
