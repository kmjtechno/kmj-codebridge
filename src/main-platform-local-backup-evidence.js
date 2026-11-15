// KMJ TECHNO — fixed, root-only, read-only backup artifact evidence for CodeBridge.
// Do not confuse presence/freshness with restore or remote SFTP validation.
import fs from 'node:fs';
import path from 'node:path';

const DAILY = '/var/backups/kmj-elite-daily';
const VAULT = '/var/backups/kmj-elite-offsite-encrypted';
const STAMP = /^20\d{6}T\d{6}Z$/;
const SIDE = /^([a-f0-9]{64})  (20\d{6}T\d{6}Z\.tar\.age)\n$/;
const MAX_LIST = 256;
const MAX_FILE = 8 * 1024 ** 3;
const HOUR = 3600000;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function fail(code) { throw new Error(code); }
function safeName(name) {
  if (!STAMP.test(name)) return false;
  const y = Number(name.slice(0,4)), m = Number(name.slice(4,6)), d = Number(name.slice(6,8));
  const hh = Number(name.slice(9,11)), mm = Number(name.slice(11,13)), ss = Number(name.slice(13,15));
  const t = new Date(Date.UTC(y,m-1,d,hh,mm,ss));
  return t.getUTCFullYear()===y && t.getUTCMonth()===m-1 && t.getUTCDate()===d &&
    t.getUTCHours()===hh && t.getUTCMinutes()===mm && t.getUTCSeconds()===ss;
}
function privateDir(root, uid) {
  const st = fs.lstatSync(root);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid!==uid || (st.mode & 0o022)) fail('ROOT_UNTRUSTED');
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== st.dev || opened.ino !== st.ino || opened.uid!==uid) fail('ROOT_CHANGED');
  } finally { fs.closeSync(fd); }
  return root;
}
function safeFile(file,uid,cap=MAX_FILE) {
  const s=fs.lstatSync(file);
  if (!s.isFile() || s.isSymbolicLink() || s.uid!==uid || (s.mode & 0o077) || s.nlink!==1 || s.size<1 || s.size>cap) fail('FILE_UNTRUSTED');
  return s;
}
function readTiny(file,uid,cap) {
  const before=safeFile(file,uid,cap);
  const fd=fs.openSync(file,fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const a=fs.fstatSync(fd);
    if (a.dev!==before.dev || a.ino!==before.ino || a.size!==before.size) fail('FILE_CHANGED');
    const buf=Buffer.alloc(before.size);
    let off=0;
    while(off<buf.length) {
      const n=fs.readSync(fd,buf,off,buf.length-off,off);
      if(n<=0)fail('FILE_CHANGED');
      off+=n;
    }
    const b=fs.fstatSync(fd);
    const c=fs.lstatSync(file);
    if(b.dev!==before.dev || b.ino!==before.ino || b.size!==before.size ||
       c.dev!==before.dev || c.ino!==before.ino || c.size!==before.size ||
       b.mtimeMs!==before.mtimeMs || c.mtimeMs!==before.mtimeMs) fail('FILE_CHANGED');
    return buf;
  } finally {fs.closeSync(fd);}
}
function names(root) {
  const listed=fs.readdirSync(root);
  if(listed.length>MAX_LIST)fail('ENTRIES_EXCEEDED');
  return listed;
}
function ageHours(st,now) {
  const hours=(now-st.mtimeMs)/HOUR;
  if (!Number.isFinite(hours) || hours<0) return null;
  return Math.round(hours*10)/10;
}
function newestDaily(root,uid,now) {
  const matched=names(root).filter(safeName).sort().reverse();
  if(!matched.length)return {state:'MISSING',stamp:null,fresh:false,ageHours:null};
  for(const stamp of matched) {
    const dir=path.join(root,stamp);
    const ds=fs.lstatSync(dir);
    if(!ds.isDirectory() || ds.isSymbolicLink() || ds.uid!==uid || (ds.mode&0o777)!==0o700)fail('DAILY_STAMP_UNTRUSTED');
    const dump=path.join(dir,'platform.dump');
    let s;
    try {s=safeFile(dump,uid);} catch(e) {if(e?.code==='ENOENT')continue;throw e;}
    if(s.size<32)fail('DUMP_TOO_SMALL');
    // Magic only. Do not read secrets, config, database records or storage trees.
    const fd=fs.openSync(dump,fs.constants.O_RDONLY|NOFOLLOW);
    let magic;
    try {const opened=fs.fstatSync(fd);if(opened.dev!==s.dev||opened.ino!==s.ino)fail('DUMP_CHANGED');
      magic=Buffer.alloc(5);if(fs.readSync(fd,magic,0,5,0)!==5)fail('DUMP_CHANGED');
    } finally {fs.closeSync(fd);}
    if(magic.toString('ascii')!=='PGDMP')fail('DUMP_MAGIC_INVALID');
    const age=ageHours(s,now);
    return {state:'PRESENT',stamp,bytes:s.size,ageHours:age,fresh:age!==null&&age<48,format:'PGDMP',restoreVerified:false};
  }
  return {state:'MISSING',stamp:matched[0],fresh:false,ageHours:null};
}
function newestCipher(root,uid,now) {
  const matched=names(root).filter(name=>name.endsWith('.tar.age')&&safeName(name.slice(0,-8))).sort().reverse();
  if(!matched.length)return {state:'MISSING',stamp:null,fresh:false,ageHours:null,sidecar:'MISSING'};
  const file=matched[0], stamp=file.slice(0,-8);
  const s=safeFile(path.join(root,file),uid);
  if(s.size<60)fail('CIPHER_TOO_SMALL');
  const side=path.join(root,stamp+'.sha256');
  let sidecar='MISSING';
  try {
    const bytes=readTiny(side,uid,91);
    if(bytes.length!==91)fail('SIDECAR_SHAPE_INVALID');
    const m=SIDE.exec(bytes.toString('ascii'));
    if(!m || m[2]!==file)fail('SIDECAR_SHAPE_INVALID');
    sidecar='FORMAT_PASS_HASH_NOT_COMPUTED';
  } catch(e) {if(e?.code!=='ENOENT')throw e;}
  const age=ageHours(s,now);
  return {state:'PRESENT',stamp,bytes:s.size,ageHours:age,fresh:age!==null&&age<48&&sidecar==='FORMAT_PASS_HASH_NOT_COMPUTED',
    sidecar,format:'AGE_CIPHER_CANNOT_INFER_RECIPIENT',remoteShaReadbackVerified:false,restoreVerified:false};
}
function boundedError(error) {
  // Never return filenames, raw error messages, .env or sensitive file data.
  if (error?.code==='ENOENT') return 'ROOT_OR_FILE_MISSING';
  if (error?.code==='EACCES'||error?.code==='EPERM')return 'ROOT_UNREADABLE';
  return 'LOCAL_EVIDENCE_NOT_ATTESTED';
}
export function mainPlatformLocalBackupEvidence({dailyRoot=DAILY,vaultRoot=VAULT,now=Date.now(),expectedUid=0}={}) {
  // Only the fixed Supervisor op can call this; the MCP tool has NO args.
  const readOnly=(root,inspect)=>{
    try {return inspect(privateDir(root,expectedUid),expectedUid,now);}
    catch(error){return {state:'UNVERIFIED',reason:boundedError(error),fresh:false};}
  };
  const daily=readOnly(dailyRoot,newestDaily);
  const vault=readOnly(vaultRoot,newestCipher);
  return {mode:'READ_ONLY',scope:'kmj-main-platform',schema:'KMJ_LOCAL_BACKUP_EVIDENCE_V1',
    daily,vault,localHealthArtifactsFresh:daily.fresh===true&&vault.fresh===true,
    exactHealthUnitExitVerified:false,remoteShaReadbackVerified:false,
    independentRestoreVerified:false,productionReleaseApproved:false,
    callerSelectedPaths:false,rootShellExecuted:false,mutations:'NONE'};
}
