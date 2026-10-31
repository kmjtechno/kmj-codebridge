#!/usr/bin/env bash
# Inspect why existing N2 instance became TERMINATED; no VM mutation, SSH or new billing.
set -Eeuo pipefail
umask 077
P=kmj-techno
Z=us-central1-a
VM=kmj-cloudos-kvm-test
TEMP="$(mktemp -d "$HOME/.kmj-n2-stop-audit.XXXXXXXX")"
trap 'rm -rf -- "$TEMP"' EXIT
echo KMJ_N2_COMPUTE_STOP_AUDIT_READONLY_V1
echo SCOPE=GCE_COMPUTE_API_AND_CLOUD_AUDIT_LOGS_NO_SSH_NO_MUTATION
timeout 45s gcloud compute instances describe "$VM" --project="$P" --zone="$Z" --format=json > "$TEMP/instance.json"
python3 - "$TEMP/instance.json" "$VM" <<'PY'
import datetime as dt,json,sys
d=json.load(open(sys.argv[1]))
assert d['name']==sys.argv[2] and d['zone'].endswith('/us-central1-a')
assert d['machineType'].endswith('/n2-standard-2')
assert d.get('advancedMachineFeatures',{}).get('enableNestedVirtualization') is True
s=d.get('scheduling') or {}
print('IDENTITY_GCE=PASS')
print('INSTANCE_ID='+str(d.get('id','UNKNOWN')))
print('STATUS='+str(d.get('status','UNKNOWN')))
print('LAST_START='+str(d.get('lastStartTimestamp','UNKNOWN')))
print('LAST_STOP='+str(d.get('lastStopTimestamp','UNKNOWN')))
a=d.get('lastStartTimestamp');b=d.get('lastStopTimestamp')
if a and b:
 try:
  sec=int((dt.datetime.fromisoformat(b)-dt.datetime.fromisoformat(a)).total_seconds())
  print('ELAPSED_LAST_START_TO_STOP_SECONDS='+str(sec))
 except (ValueError,TypeError):pass
for k in ('provisioningModel','preemptible','automaticRestart','onHostMaintenance',
          'maxRunDuration','terminationTime','instanceTerminationAction','gracefulShutdown'):
 val=s.get(k,'NOT_CONFIGURED')
 print('SCHEDULING_'+k.upper()+'='+str(val)[:160])
print('RESOURCE_POLICY_COUNT='+str(len(d.get('resourcePolicies') or [])))
print('LAST_START_TO_STOP_GCE_API=PASS')
PY
echo ACTION=READ_RECENT_COMPUTE_OPERATIONS
if timeout 70s gcloud compute operations list --project="$P" \
 --filter="zone:($Z)" --limit=250 --format=json >"$TEMP/operations.json" 2>"$TEMP/op.err"; then
 python3 - "$TEMP/operations.json" "$VM" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
name=sys.argv[2]
print('OPERATIONS_API=PASS')
matches=[]
for item in d if isinstance(d,list) else []:
 target=str(item.get('targetLink',''))
 if not target.endswith('/instances/'+name):continue
 matches.append(item)
print('OPERATIONS_MATCHING_VM='+str(len(matches)))
matches.sort(key=lambda r:r.get('insertTime',''),reverse=True)
for i,p in enumerate(matches[:15]):
 print('OP_'+str(i)+'_TYPE='+str(p.get('operationType','UNKNOWN'))[:65])
 print('OP_'+str(i)+'_STATUS='+str(p.get('status','UNKNOWN'))[:50])
 print('OP_'+str(i)+'_INSERTED='+str(p.get('insertTime','UNKNOWN'))[:50])
 print('OP_'+str(i)+'_ENDED='+str(p.get('endTime','UNKNOWN'))[:50])
 print('OP_'+str(i)+'_USER='+str(p.get('user','NOT_REPORTED'))[:120])
 if p.get('error'):
  errors=p['error'].get('errors',[])
  print('OP_'+str(i)+'_ERROR_CODES='+','.join(str(x.get('code','?'))[:60] for x in errors[:4]))
PY
else
 echo OPERATIONS_API=UNAVAILABLE
 python3 - "$TEMP/op.err" <<'PY'
from pathlib import Path
import re,sys
s=Path(sys.argv[1]).read_text(errors='replace')
print('OPERATIONS_PERMISSION_ERROR='+str(bool(re.search('permission|403|denied',s,re.I))))
print('OPERATIONS_SYNTAX_OR_FILTER_ERROR='+str(bool(re.search('invalid|unrecognized|filter|syntax',s,re.I))))
PY
fi
echo ACTION=READ_ADMIN_AUDIT_EVENTS_FOR_VM_STOP_WINDOW
ID="$(python3 - "$TEMP/instance.json" <<'PY'
import json,sys
print(str(json.load(open(sys.argv[1])).get('id','')))
PY
)"
FILTER="protoPayload.serviceName=\"compute.googleapis.com\" AND timestamp>=\"2026-10-31T12:20:00Z\" AND timestamp<=\"2026-10-31T13:25:00Z\" AND (protoPayload.resourceName:\"$VM\" OR resource.labels.instance_id=\"$ID\")"
if timeout 70s gcloud logging read "$FILTER" --project="$P" --limit=150 --format=json \
 >"$TEMP/audit.json" 2>"$TEMP/audit.err"; then
 python3 - "$TEMP/audit.json" <<'PY'
import hashlib,json,sys
records=json.load(open(sys.argv[1]))
print('AUDIT_LOG_QUERY=PASS')
print('AUDIT_VM_EVENTS='+str(len(records) if isinstance(records,list) else 0))
for i,e in enumerate(records[:35] if isinstance(records,list) else []):
 payload=e.get('protoPayload') or {}
 auth=payload.get('authenticationInfo') or {}
 principal=auth.get('principalEmail') or auth.get('principalSubject') or ''
 if not isinstance(principal,str):principal=''
 kind='SERVICE_ACCOUNT' if principal.endswith('.gserviceaccount.com') else ('PERSON_OR_WORKLOAD' if principal else 'NOT_REPORTED')
 ident=hashlib.sha256(principal.encode()).hexdigest()[:12] if principal else 'NOT_REPORTED'
 print('AUDIT_'+str(i)+'_TIMESTAMP='+str(e.get('timestamp','UNKNOWN'))[:50])
 print('AUDIT_'+str(i)+'_METHOD='+str(payload.get('methodName','UNKNOWN'))[:130])
 print('AUDIT_'+str(i)+'_PRINCIPAL_KIND='+kind)
 print('AUDIT_'+str(i)+'_PRINCIPAL_HASH='+ident)
 print('AUDIT_'+str(i)+'_STATUS_CODE='+str((payload.get('status') or {}).get('code','NOT_REPORTED'))[:60])
PY
else
 echo AUDIT_LOG_QUERY=UNAVAILABLE
 python3 - "$TEMP/audit.err" <<'PY'
from pathlib import Path
import re,sys
s=Path(sys.argv[1]).read_text(errors='replace')
for name,pattern in {'IAM':r'denied|permission|403','API_DISABLED':r'not enabled|has not been used','SYNTAX':r'Invalid|syntax|filter','QUOTA':r'429|quota|rate limit'}.items():
 print('AUDIT_FAILURE_'+name+'='+str(bool(re.search(pattern,s,re.I))))
PY
fi
echo RESULT=NO_SSH_GCE_STOP_CAUSE_EVIDENCE_COLLECTED
echo NO_VM_RESTART_OR_FIREWALL_CHANGES=YES
echo RECEIPT_COMPLETE=YES
