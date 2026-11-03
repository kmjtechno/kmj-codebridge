#!/usr/bin/env python3
"""KMJ-elite owner-only signed stable15 gateway cutover.

Preserve signed14 root-owned override as rollback authority. Create only a
lexicographically later signed15 override. Never touch keys, updater, agent,
Nginx, source repos, stable/current, or an existing override. Verify direct,
local-Nginx, and public commit+MCP schemas; rollback on any failure.
"""
import hashlib
import json
import os
import pathlib
import re
import signal
import socket
import stat
import subprocess
import sys
import time

UNIT = "kmj-codebridge-gateway-stage.service"
UNIT_PATH = pathlib.Path("/etc/systemd/system/kmj-codebridge-gateway-stage.service")
DIR = pathlib.Path("/etc/systemd/system/kmj-codebridge-gateway-stage.service.d")
OLD_CONF = DIR / "zzzz-kmj-signed14.conf"
NEW_CONF = DIR / "zzzz-kmj-signed15.conf"
OLD_CONF_SHA = "bce141328b15907eee701f2a821ed76b8f15fecfa1275ffbd893b77e0085cefb"
OLD_DIR = pathlib.Path("/opt/kmj-codebridge-stable/releases/0.3.2-2d713aa9aa9a")
NEW_DIR = pathlib.Path("/opt/kmj-codebridge-stable/releases/0.3.2-1d216841f9b2")
STABLE_CURRENT = pathlib.Path("/opt/kmj-codebridge-stable/current")
NEW_SHA = "1d216841f9b2a3aaa80fa42d6a24ab62fd23da2f"
NODE = "/opt/kmj-codebridge-node/bin/node"
LOCK = pathlib.Path("/run/lock/kmj-codebridge-gateway-signed15.lock")
PUBLIC_HOST = "kmjtechno.com"
REQUIRED = frozenset([
    "autopilot_local_draft", "chat_lane_release", "chat_lane_reserve",
    "chat_lane_status", "chat_workspace_open", "compact_work_brief",
    "fleet_overview", "local_model_generate", "local_model_status",
    "project_progress", "render_codebridge_status", "worktree_lane_cleanup",
    "worktree_lane_prepare", "worktree_lane_status",
])
CRITICAL = {
    "chat_workspace_open": ("device","project","lane","ifNoneMatch","maxEntries","recentJobs"),
    "coordination_list": ("device","project","limit","after"),
    "coordination_post": ("device","project","actor","recipient","requestKey","kind","note"),
    "autopilot_claim": ("device","project"),
    "autopilot_checkpoint": ("device","project","task","leaseToken"),
    "autopilot_wait": ("device","project","task","leaseToken"),
    "autopilot_complete": ("device","project","task","leaseToken"),
}

class Blocked(Exception):
    pass

def need(condition, code):
    if not condition:
        raise Blocked(code)

def cmd(*argv, input=None, timeout=25):
    try:
        p = subprocess.run(argv, input=input, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("COMMAND_UNAVAILABLE") from None
    need(p.returncode == 0, "COMMAND_FAILED")
    need(len(p.stdout) <= 2*1024*1024, "COMMAND_OUTPUT_TOO_LARGE")
    return p.stdout.decode("utf-8", "replace").strip()

def show(prop):
    return cmd("systemctl","show",UNIT,"-P",prop,timeout=12)

def regular_owner_file(path, private=True, max_size=65536):
    try:
        fd=os.open(path,os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            st=os.fstat(fd)
            need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and st.st_nlink == 1
                 and st.st_size >= 1 and st.st_size <= max_size
                 and (st.st_mode & (0o077 if private else 0o022)) == 0,
                 "UNTRUSTED_OWNER_FILE")
            data=os.read(fd,max_size+1)
            need(len(data)==st.st_size,"OWNER_FILE_RACE")
            return data
        finally:
            os.close(fd)
    except (OSError,ValueError):
        raise Blocked("OWNER_FILE_UNAVAILABLE") from None

def require_root_parent(path):
    for ancestor in [pathlib.Path("/"), *reversed(path.parent.parents), path.parent]:
        try: st=os.lstat(ancestor)
        except OSError: raise Blocked("OWNER_PARENT_MISSING") from None
        need(stat.S_ISDIR(st.st_mode) and st.st_uid==0 and (st.st_mode&0o022)==0,
             "OWNER_PARENT_UNTRUSTED")

def old_conf_and_gateway_config():
    require_root_parent(OLD_CONF)
    data=regular_owner_file(OLD_CONF,max_size=16384)
    need(hashlib.sha256(data).hexdigest()==OLD_CONF_SHA, "SIGNED14_OVERRIDE_DRIFT")
    text=data.decode("utf-8")
    wds=re.findall(r"^WorkingDirectory=(.+)$",text,re.M)
    execs=re.findall(r"^ExecStart=(.*)$",text,re.M)
    need(wds==[str(OLD_DIR)] and len(execs)==2 and execs[0]=="",
         "SIGNED14_DIRECTIVES_UNEXPECTED")
    pattern=(r"/opt/kmj-codebridge-node/bin/node "
             +re.escape(str(OLD_DIR))+
             r"/src/cli\.js gateway (/[A-Za-z0-9_./-]+)")
    m=re.fullmatch(pattern,execs[1])
    need(m is not None, "SIGNED14_EXEC_UNEXPECTED")
    return data,m.group(1)

def validate_runtime():
    need(STABLE_CURRENT.is_symlink()
         and STABLE_CURRENT.resolve(strict=True)==NEW_DIR,
         "SIGNED15_CURRENT_POINTER_MISMATCH")
    for file in [NEW_DIR/"src/cli.js",NEW_DIR/"package.json"]:
        need(file.is_file() and not file.is_symlink() and file.stat().st_size > 0,
             "SIGNED15_RUNTIME_FILE_MISSING")
    package=json.loads((NEW_DIR/"package.json").read_text("utf-8"))
    need(package.get("version")=="0.3.2","SIGNED15_RUNTIME_VERSION_MISMATCH")
    need(pathlib.Path(NODE).is_file() and os.access(NODE,os.X_OK),
         "NODE24_UNAVAILABLE")

def validate_service():
    need(show("LoadState")=="loaded" and show("FragmentPath")==str(UNIT_PATH),
         "UNEXPECTED_SYSTEMD_UNIT")
    need(show("ActiveState")=="active" and show("NeedDaemonReload")=="no",
         "GATEWAY_NOT_READY")
    need(show("User")=="kmjcode","GATEWAY_USER_DRIFT")
    need(show("WorkingDirectory")==str(OLD_DIR),"GATEWAY_OLD_RUNTIME_DRIFT")
    try: oldpid=int(show("MainPID"))
    except ValueError: raise Blocked("GATEWAY_OLD_PID_INVALID") from None
    need(oldpid>1 and pathlib.Path(f"/proc/{oldpid}/cwd").resolve()==OLD_DIR,
         "GATEWAY_OLD_PROCESS_DRIFT")
    paths=show("DropInPaths").split()
    need(len(paths)<=30 and str(OLD_CONF) in paths,"SIGNED14_DROPIN_NOT_LOADED")
    need(not os.path.lexists(NEW_CONF),"SIGNED15_DROPIN_ALREADY_EXISTS")
    need(all(pathlib.PurePosixPath(p).name<NEW_CONF.name for p in paths),
         "LATER_SYSTEMD_OVERRIDE_CONFLICT")
    need(not os.path.lexists(LOCK),"GATEWAY_OWNER_LOCK_PRESENT")
    return oldpid

def gateway_port(file):
    f=pathlib.Path(file)
    data=regular_owner_file(f,private=False,max_size=256*1024)
    cfg=json.loads(data)
    port=cfg.get("port",8787)
    host=cfg.get("host","127.0.0.1")
    need(type(port)==int and 1<=port<=65535 and host in ("127.0.0.1","localhost"),
         "GATEWAY_PORT_NOT_LOCAL")
    return port

def rpc_messages(text):
    candidates=[text.strip()]
    candidates += [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
    result=[]
    for item in candidates:
        try: result.append(json.loads(item))
        except (ValueError,TypeError): pass
    return result

def origin_probe(origin,port):
    if origin=="DIRECT":
        url=f"http://127.0.0.1:{port}/mcp";extra=[]
    else:
        url=f"https://{PUBLIC_HOST}/mcp"
        extra=["--resolve",f"{PUBLIC_HOST}:443:127.0.0.1"] if origin=="LOCAL_NGINX" else []
    def post(method,number,params):
        payload=json.dumps({"jsonrpc":"2.0","id":number,"method":method,"params":params},
                           separators=(",",":")).encode()
        args=["curl","-fsS","--max-time","15","--connect-timeout","4",
              *extra,"-H",f"Host: {PUBLIC_HOST}",
              "-H","Content-Type: application/json",
              "-H","Accept: application/json, text/event-stream",
              "--data-binary","@-",url]
        try:
            p=subprocess.run(args,input=payload,capture_output=True,timeout=20)
        except (OSError,subprocess.TimeoutExpired):
            raise Blocked(origin+"_PROBE_UNAVAILABLE") from None
        need(p.returncode==0 and len(p.stdout)<=1048576,
             origin+"_MCP_RESPONSE_UNVERIFIED")
        return rpc_messages(p.stdout.decode("utf-8","replace"))
    catalog=post("tools/list",1,{})
    tools=next((item["result"]["tools"] for item in catalog
                if isinstance(item,dict) and isinstance(item.get("result"),dict)
                and isinstance(item["result"].get("tools"),list)),None)
    need(tools is not None and len(tools)>=100,origin+"_CATALOG_SMALL")
    names=[x.get("name") for x in tools if isinstance(x,dict)]
    need(len(names)==len(tools) and len(set(names))==len(names)
         and REQUIRED.issubset(names),origin+"_REQUIRED_TOOLS_MISSING")
    lookup={x["name"]:x for x in tools}
    for tool,fields in CRITICAL.items():
        shape=lookup.get(tool,{}).get("inputSchema",{})
        props=shape.get("properties",{}) if isinstance(shape,dict) else {}
        need(type(props)==dict and all(field in props for field in fields),
             origin+"_CRITICAL_SCHEMA_MISSING")
    init=post("initialize",2,{
      "protocolVersion":"2025-06-18","capabilities":{},
      "clientInfo":{"name":"signed15-gateway-verifier","version":"1.0.0"}})
    commit=next((item["result"]["serverInfo"].get("commit")
                 for item in init if isinstance(item,dict) and
                 isinstance(item.get("result"),dict) and
                 isinstance(item["result"].get("serverInfo"),dict)),None)
    return {"count":len(tools),"commit":commit}

def effective_new(target,config):
    need(show("NeedDaemonReload")=="no","SYSTEMD_RELOAD_PENDING")
    need(show("WorkingDirectory")==str(target),"SYSTEMD_NEW_WORKDIR_NOT_EFFECTIVE")
    effective=show("ExecStart")
    need(f"{target}/src/cli.js" in effective and f" gateway {config}" in effective,
         "SYSTEMD_NEW_EXEC_NOT_EFFECTIVE")
    need(str(NEW_CONF) in show("DropInPaths").split(),"SIGNED15_DROPIN_NOT_LOADED")
    need(f"CODEBRIDGE_SOURCE_COMMIT={NEW_SHA}" in show("Environment"),
         "SYSTEMD_NEW_COMMIT_ENV_NOT_EFFECTIVE")

def new_content(config):
    return ("[Service]\n"
            f"WorkingDirectory={NEW_DIR}\n"
            f"Environment=CODEBRIDGE_SOURCE_COMMIT={NEW_SHA}\n"
            "ExecStart=\n"
            f"ExecStart={NODE} {NEW_DIR}/src/cli.js gateway {config}\n").encode()

def write_new(data):
    require_root_parent(NEW_CONF)
    fd=os.open(NEW_CONF,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600)
    try:
        os.fchmod(fd,0o600)
        os.write(fd,data)
        os.fsync(fd)
    finally: os.close(fd)
    dirfd=os.open(DIR,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(dirfd)
    finally: os.close(dirfd)

def remove_only_our_new(data):
    current=regular_owner_file(NEW_CONF,max_size=16384)
    need(current==data,"SIGNED15_DROPIN_CHANGED_REFUSE_DELETE")
    os.unlink(NEW_CONF)
    cmd("systemctl","daemon-reload",timeout=40)

def check_runtime_and_origins(port,old_count):
    need(show("ActiveState")=="active","GATEWAY_RESTART_NOT_ACTIVE")
    pid=int(show("MainPID"))
    need(pid>1 and pathlib.Path(f"/proc/{pid}/cwd").resolve()==NEW_DIR,
         "GATEWAY_NEW_PROCESS_WRONG_RUNTIME")
    for origin in ("DIRECT","LOCAL_NGINX","PUBLIC"):
        seen=origin_probe(origin,port)
        need(seen["count"]>=max(100,old_count) and seen["commit"]==NEW_SHA,
             origin+"_SIGNED15_RUNTIME_UNVERIFIED")
        print(origin+"_SIGNED15_CATALOG_AND_COMMIT=PASS")
    return pid

def rollback(data,port,old_count,was_restarted):
    remove_only_our_new(data)
    if was_restarted: cmd("systemctl","restart",UNIT,timeout=90)
    need(show("ActiveState")=="active" and show("WorkingDirectory")==str(OLD_DIR),
         "ROLLBACK_SYSTEMD_NOT_OLD")
    pid=int(show("MainPID"))
    need(pid>1 and pathlib.Path(f"/proc/{pid}/cwd").resolve()==OLD_DIR,
         "ROLLBACK_RUNTIME_NOT_OLD")
    observed=origin_probe("DIRECT",port)
    need(observed["count"]>=old_count,"ROLLBACK_CATALOG_NOT_HEALTHY")
    print("GATEWAY_ROLLBACK=PASS")

def run():
    need(os.geteuid()==0 and socket.gethostname().split(".")[0].lower()=="kmj-elite",
         "WRONG_ROOT_OR_HOST")
    need(sys.argv[1:] in ([],["--apply","--confirm-no-active-jobs"]),
         "INVALID_ARGS")
    _,config=old_conf_and_gateway_config()
    validate_runtime()
    oldpid=validate_service()
    port=gateway_port(config)
    old=origin_probe("DIRECT",port)
    need(old["count"]>=100,"GATEWAY_BASELINE_UNVERIFIED")
    print("SIGNED15_GATEWAY_PREFLIGHT=PASS")
    print("BASELINE_TOOL_COUNT="+str(old["count"]))
    if not sys.argv[1:]:
        print("SIGNED15_GATEWAY=DRY_RUN_UNCHANGED")
        return

    fd=os.open(LOCK,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    data=new_content(config)
    created=False;restarted=False
    try:
        os.write(fd,str(os.getpid()).encode()+b"\n")
        os.fsync(fd)
        # Recheck baseline immediately before any systemd mutation.
        need(validate_service_recheck(oldpid),"GATEWAY_BASELINE_CHANGED")
        write_new(data);created=True
        cmd("systemctl","daemon-reload",timeout=40)
        effective_new(NEW_DIR,config)
        restarted=True
        cmd("systemctl","restart",UNIT,timeout=90)
        need(int(show("MainPID"))!=oldpid,"GATEWAY_PID_NOT_CHANGED")
        pid=None
        for attempt in range(6):
            try:
                pid=check_runtime_and_origins(port,old["count"])
                break
            except Blocked:
                if attempt==5:raise
                time.sleep(2)
        print("GATEWAY_SIGNED15=LIVE_PASS")
        print("GATEWAY_PID_CHANGED=PASS")
        print("AGENT_RECONNECT=REQUIRES_AUTHENTICATED_CLIENT")
    except Exception as error:
        reason=error.args[0] if isinstance(error,Blocked) else "UNCLASSIFIED"
        print("GATEWAY_SIGNED15=BLOCKED:"+str(reason))
        if created:
            try: rollback(data,port,old["count"],restarted)
            except Exception:
                print("GATEWAY_ROLLBACK=FAILED_OWNER_REVIEW_REQUIRED")
        raise Blocked("CUTOVER_FAILED") from None
    finally:
        os.close(fd)
        try: os.unlink(LOCK)
        except OSError: pass

def validate_service_recheck(oldpid):
    try:
        return (show("ActiveState")=="active" and
                show("WorkingDirectory")==str(OLD_DIR) and
                int(show("MainPID"))==oldpid and
                hashlib.sha256(regular_owner_file(OLD_CONF,max_size=16384)).hexdigest()==OLD_CONF_SHA
                and not os.path.lexists(NEW_CONF))
    except (Blocked,ValueError,OSError):
        return False

if __name__=="__main__":
    try:run()
    except (Blocked,OSError,ValueError,KeyError,TypeError,json.JSONDecodeError) as e:
        safe=e.args[0] if isinstance(e,Blocked) else "UNCLASSIFIED"
        print("SIGNED15_GATEWAY_RESULT=BLOCKED:"+str(safe))
        raise SystemExit(2)
