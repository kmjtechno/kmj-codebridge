#!/usr/bin/env python3
"""Read-only SHA256 plan for N2 guest liburing2 dependency."""
import os,re,subprocess,sys
if os.uname().nodename.split(".")[0]!="kmj-cloudos-kvm-test":raise SystemExit("WRONG_HOST")
s=subprocess.run(["apt-cache","show","liburing2"],text=True,capture_output=True,timeout=12,check=True).stdout
for block in s.split("\n\n"):
 f={}
 for line in block.splitlines():
  if ": " in line and not line.startswith(" "):
   k,v=line.split(": ",1);f[k]=v
 if f.get("Package")!="liburing2" or f.get("Architecture")!="amd64":continue
 path=f.get("Filename","");digest=f.get("SHA256","");version=f.get("Version","")
 if (re.fullmatch(r"pool/[A-Za-z0-9_+./%-]+[.]deb",path)
     and ".." not in path and re.fullmatch("[a-f0-9]{64}",digest)
     and re.fullmatch(r"[A-Za-z0-9.+:~-]+",version)):
  print("LIBURING_PACKAGE=liburing2")
  print("LIBURING_VERSION="+version)
  print("LIBURING_SHA256="+digest)
  print("LIBURING_APT_PATH="+path)
  print("RESULT=LIBURING_PLAN_PASS")
  sys.exit(0)
raise SystemExit("LIBURING_APT_METADATA_NOT_FOUND")
