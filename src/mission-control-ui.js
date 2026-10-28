export const KMJ_MISSION_CONTROL_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>KMJ CodeBridge — Mission Control</title>
<style>
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark;--text:#f4f6fc;--muted:#a5aec6;--soft:#75829f;--edge:rgba(205,217,255,.12);--glass:rgba(16,23,43,.88);--accent:#a69aff;--cyan:#79e6e3;--amber:#f7c57e;--red:#ff9a9a}
*{box-sizing:border-box}
body{margin:0;min-width:280px;background:#070b15;color:var(--text)}
button{font:inherit}
.shell{isolation:isolate;overflow:hidden;position:relative;border:1px solid rgba(189,209,255,.16);border-radius:22px;padding:23px;background:radial-gradient(ellipse 90% 90% at 80% -5%,rgba(80,65,160,.29),transparent 65%),radial-gradient(ellipse 70% 60% at -10% 80%,rgba(34,133,153,.16),transparent 72%),linear-gradient(145deg,#0e1425,#090e1a);box-shadow:0 20px 60px rgba(0,0,0,.22)}
.shell::before{content:"";position:absolute;inset:0;pointer-events:none;opacity:.18;background-image:linear-gradient(90deg,transparent 98%,#667799 100%),linear-gradient(0deg,transparent 98%,#667799 100%);background-size:32px 32px;mask-image:linear-gradient(110deg,transparent,black 60%,transparent)}
header,.brand,.micro,.headline,.cards,.foot,.statusrow{display:flex;align-items:center}
header{justify-content:space-between;gap:14px;position:relative}
.brand{gap:11px;min-width:0}
.brand img{width:42px;height:42px;object-fit:contain;flex:none;filter:drop-shadow(0 2px 12px rgba(215,45,51,.12))}
.brand strong{display:block;font-size:14px;letter-spacing:.025em;line-height:1.35}
.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:.12em;margin-top:3px}
.pill{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid var(--edge);border-radius:999px;color:#ced7e9;background:rgba(255,255,255,.035);white-space:nowrap;font-size:10px;letter-spacing:.05em}
.dot{height:6px;width:6px;flex:none;background:#8792b5;border-radius:50%}
.pill.has-data .dot{background:var(--cyan);box-shadow:0 0 13px rgba(121,230,227,.55)}
.micro{gap:9px;margin:25px 0 8px;font-size:10px;font-weight:750;letter-spacing:.18em;text-transform:uppercase;color:var(--cyan)}
.micro:before{content:"";height:1px;width:20px;background:currentColor;opacity:.8}
.headline{align-items:flex-start;gap:12px;justify-content:space-between}
h1{margin:0;font-size:clamp(23px,4.6vw,36px);letter-spacing:-.055em;line-height:1.1;font-weight:780}
h1 span{background:linear-gradient(100deg,#cfc6ff 0%,#b9e6ff 95%);color:transparent;background-clip:text;-webkit-background-clip:text}
.subtitle{color:var(--muted);font-size:12px;line-height:1.65;margin:9px 0 0;max-width:510px}
.project{display:inline-block;overflow-wrap:anywhere;font-weight:650;color:#ecf2ff}
.motion-icon{width:54px;height:54px;flex:none;border:1px solid rgba(170,159,255,.24);border-radius:16px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(138,126,244,.15),rgba(55,210,216,.06));box-shadow:inset 0 1px rgba(255,255,255,.08)}
.motion-icon svg{width:31px;height:31px;fill:none;stroke:#bfbaff;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
nav{margin:21px 0 17px;padding:4px;display:flex;gap:4px;width:max-content;max-width:100%;border-radius:11px;background:rgba(231,233,255,.045);border:1px solid var(--edge)}
nav button{cursor:pointer;color:#9ca8be;border:0;background:none;border-radius:8px;padding:8px 11px;font-size:11px;font-weight:650;transition:background .16s,color .16s}
nav button[aria-selected="true"]{color:#f5f5ff;background:#263150;box-shadow:inset 0 1px rgba(255,255,255,.07)}
nav button:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
[hidden]{display:none!important}
.panel{position:relative;min-height:220px}
.cards{gap:10px;align-items:stretch;flex-wrap:wrap}
.metric{min-width:100px;flex:1 1 115px;padding:14px;border:1px solid var(--edge);border-radius:13px;background:var(--glass);position:relative;overflow:hidden}
.metric:before{content:"";height:2px;position:absolute;left:14px;right:14px;top:0;background:linear-gradient(90deg,transparent,rgba(157,148,255,.65),transparent)}
.metric label{display:block;color:var(--muted);font-size:10px;font-weight:600;margin-bottom:10px}
.metric b{display:block;font-size:26px;line-height:1;letter-spacing:-.04em;font-weight:730;font-variant-numeric:tabular-nums}
.metric em{display:block;font-style:normal;color:var(--soft);font-size:10px;margin-top:9px}
.metric.cyan:before{background:linear-gradient(90deg,transparent,rgba(121,230,227,.8),transparent)}
.metric.warn:before{background:linear-gradient(90deg,transparent,rgba(247,197,126,.8),transparent)}
.flow{display:grid;grid-template-columns:1fr 22px 1fr 22px 1fr;gap:8px;align-items:center;margin-top:12px}
.node{position:relative;min-width:0;min-height:72px;border:1px solid var(--edge);border-radius:12px;background:rgba(16,24,45,.7);padding:13px 12px;display:flex;flex-direction:column;justify-content:center}
.node strong{font-size:12px;font-weight:710}
.node span{font-size:10px;color:var(--soft);margin-top:6px;overflow-wrap:anywhere}
.connector{height:1px;background:linear-gradient(90deg,#655d8e,#72d0d2);position:relative}
.connector:after{content:"";position:absolute;right:0;top:-3px;width:6px;height:6px;border-top:1px solid #72d0d2;border-right:1px solid #72d0d2;transform:rotate(45deg)}
.node.active{border-color:rgba(121,230,227,.55);box-shadow:inset 0 0 25px rgba(121,230,227,.035)}
.node.active:before{content:"";position:absolute;top:12px;right:12px;height:6px;width:6px;border-radius:50%;background:var(--cyan);box-shadow:0 0 11px var(--cyan)}
.node.busy:before{animation:signal 1.8s ease-in-out infinite}
.note{color:var(--muted);font-size:11px;line-height:1.65;margin:11px 0 0}
.sectiontitle{color:#e9edfb;font-size:12px;font-weight:720;letter-spacing:.025em;margin:0 0 12px}
.list{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}
.cell{padding:12px;border:1px solid var(--edge);border-radius:12px;background:rgba(16,24,45,.68)}
.cell small{display:block;color:var(--muted);font-size:10px;margin-bottom:8px}
.cell strong{font-variant-numeric:tabular-nums;font-size:19px;font-weight:720}
.detail{display:grid;grid-template-columns:minmax(0,100px) minmax(0,1fr);gap:9px 15px;padding:17px;background:rgba(16,24,45,.55);border:1px solid var(--edge);border-radius:13px;font-size:11px}
.detail dt{color:var(--muted);margin:0}
.detail dd{margin:0;color:#eef2ff;font-weight:590;overflow-wrap:anywhere}
.foot{gap:12px;justify-content:space-between;border-top:1px solid var(--edge);margin-top:20px;padding-top:12px;color:#8b97b0;font-size:10px}
.foot span{line-height:1.6}
.foot strong{color:#b9c6de;font-weight:650}
.statusrow{gap:8px;margin-top:10px;font-size:10px;color:#90a6b9}
.statusrow i{width:6px;height:6px;border-radius:50%;background:var(--cyan)}
.timeline{list-style:none;padding:0;margin:10px 0 0;display:grid;gap:8px}
.timeline li{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;column-gap:11px;padding:10px 12px;border-radius:10px;background:rgba(16,24,45,.64);border:1px solid var(--edge)}
.timeline li i{height:7px;width:7px;border-radius:50%;background:#8295b6}
.timeline li[data-state="running"] i{background:var(--cyan);box-shadow:0 0 12px rgba(121,230,227,.35)}
.timeline li[data-state="succeeded"] i{background:#91e1ad}
.timeline li[data-state="failed"] i,.timeline li[data-state="timed_out"] i{background:var(--red)}
.timeline li[data-state="queued"] i{background:var(--amber)}
.timeline li strong{font-size:11px;font-weight:650;overflow-wrap:anywhere}
.timeline li time{font-size:9px;color:var(--muted);font-variant-numeric:tabular-nums;overflow-wrap:anywhere;text-align:right}
@media(max-width:440px){.timeline li{grid-template-columns:8px 1fr}.timeline li time{grid-column:2;text-align:left;margin-top:4px}}
.workspace-grid{display:grid;grid-template-columns:minmax(132px,1fr) minmax(0,2.2fr);gap:10px}
.files-pane,.diff-pane{background:rgba(16,24,45,.73);border:1px solid var(--edge);border-radius:13px;padding:12px;min-width:0}
.file-list{display:flex;flex-direction:column;gap:4px;max-height:320px;overflow:auto;margin-top:10px}
.file-button{display:block;text-align:left;white-space:normal;word-break:break-word;width:100%;border:1px solid transparent;border-radius:7px;background:transparent;color:#c0cde3;font-size:10px;padding:8px 7px;cursor:pointer}
.file-button[aria-pressed="true"]{background:rgba(121,230,227,.09);border-color:rgba(121,230,227,.3);color:#e3ffff}
.file-button:focus-visible{outline:2px solid var(--cyan);outline-offset:1px}
.patch{margin:9px 0 0;padding:12px;border-radius:9px;background:rgba(0,0,0,.22);color:#b9d8cf;white-space:pre-wrap;overflow-wrap:anywhere;max-height:310px;overflow-y:auto;font:10px/1.5 ui-monospace,Consolas,monospace;tab-size:2}
@media(max-width:520px){.workspace-grid{grid-template-columns:1fr}.file-list{max-height:150px}.patch{max-height:240px}}
@media(prefers-color-scheme:light){.files-pane,.diff-pane{background:rgba(255,255,255,.78)}.file-button{color:#273e59}.file-button[aria-pressed="true"]{color:#1b4b55;background:#ddf3f1}.patch{background:#eaf0f5;color:#205047}}
@keyframes signal{50%{opacity:.27;box-shadow:0 0 20px var(--cyan)}}
@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation:none!important;transition:none!important}}
@media(max-width:520px){.shell{padding:17px;border-radius:15px}.pill{padding:6px 8px;font-size:9px}.brand img{width:36px;height:36px}.brand small{letter-spacing:.04em}.motion-icon{display:none}.flow{gap:4px;grid-template-columns:1fr 10px 1fr 10px 1fr}.node{padding:9px 7px;min-height:78px}.node strong{font-size:10px}.node span{font-size:9px}.foot{align-items:flex-start;flex-direction:column;gap:3px}}
@media(prefers-color-scheme:light){:root{color-scheme:light;--text:#141d30;--muted:#4f607a;--soft:#64738b;--edge:rgba(51,68,99,.18);--glass:rgba(255,255,255,.78)}body{color:#141d30;background:#edf1f8}.shell{background:radial-gradient(ellipse 70% 90% at 80% -15%,#ded9ff,transparent 72%),linear-gradient(145deg,#f8faff,#ecf3fa)}.brand strong,h1,.sectiontitle{color:#16223a}.pill{color:#263856;background:#fff}.subtitle,.node span,.note{color:#536581}.project{color:#233a54}.node,.cell,.detail{background:rgba(255,255,255,.75)}.detail dd{color:#172942}nav{background:#e3e9f5}nav button[aria-selected="true"]{color:#fff;background:#344564}h1 span{color:#3e478c;background:none}.foot strong{color:#374967}}
</style>
</head>
<body>
<article class="shell" role="region" aria-label="KMJ CodeBridge Mission Control">
<header>
  <div class="brand"><img alt="Approved KMJ TECHNO icon" src="__CODEBRIDGE_APPROVED_ICON_URL__" width="42" height="42">
  <div><strong>KMJ CODEBRIDGE</strong><small>INNOVATE | BUILD | SCALE</small></div></div>
  <div class="pill" id="signalPill"><i class="dot" aria-hidden="true"></i><span id="signalText">AWAITING EVIDENCE</span></div>
</header>
<div class="micro">MISSION CONTROL / PROJECT STATUS</div>
<div class="headline">
  <div><h1>Engineering, <span>in motion.</span></h1>
  <p class="subtitle"><span class="project" id="project">Authorized project</span> · Verified work signals, not simulated progress.</p></div>
  <div class="motion-icon" aria-hidden="true"><svg viewBox="0 0 38 38"><circle cx="19" cy="19" r="11"/><circle cx="19" cy="19" r="3"/><path d="M19 2v6M19 30v6M2 19h6M30 19h6M6 6l4 4M28 28l4 4"/></svg></div>
</div>
<nav role="tablist" aria-label="Mission Control views">
  <button type="button" role="tab" id="tab-overview" aria-controls="panel-overview" aria-selected="true" data-view="overview">Overview</button>
  <button type="button" role="tab" id="tab-work" aria-controls="panel-work" aria-selected="false" data-view="work" tabindex="-1">Workstream</button>
  <button type="button" role="tab" id="tab-evidence" aria-controls="panel-evidence" aria-selected="false" data-view="evidence" tabindex="-1">Evidence</button>
  <button type="button" role="tab" id="tab-workspace" aria-controls="panel-workspace" aria-selected="false" data-view="workspace" tabindex="-1">Workspace</button>
</nav>
<section class="panel" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview">
  <div class="cards">
    <div class="metric cyan"><label>RUNNING TASKS</label><b id="running">—</b><em>Authenticated task report</em></div>
    <div class="metric"><label>QUEUED TASKS</label><b id="queued">—</b><em>From project queue</em></div>
    <div class="metric warn"><label>AVAILABLE SLOTS</label><b id="slots">—</b><em>Authorized capacity only</em></div>
  </div>
  <p class="sectiontitle" style="margin-top:18px">Engineering signal flow</p>
  <div class="flow" aria-label="Observed work stages">
    <div class="node" id="node-inspect"><strong>01 · Inspect</strong><span id="inspectState">Not verified</span></div>
    <div class="connector" aria-hidden="true"></div>
    <div class="node" id="node-execute"><strong>02 · Execute</strong><span id="executeState">Not reported</span></div>
    <div class="connector" aria-hidden="true"></div>
    <div class="node" id="node-verify"><strong>03 · Verify</strong><span id="verifyState">Requires independent gates</span></div>
  </div>
  <p class="note" id="nextAction">Use a verified CodeBridge tool to inspect the next action.</p>
  <div style="margin-top:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <button id="refreshProgress" type="button" style="padding:8px 11px;border:1px solid var(--edge);border-radius:9px;background:var(--glass);color:var(--text);cursor:pointer">Refresh progress</button>
    <span class="note" id="progressRefreshNotice" role="status">Status is the last authenticated snapshot, not continuous polling.</span>
  </div>
  <div style="margin-top:18px;border:1px solid var(--edge);border-radius:12px;padding:13px;background:var(--glass)">
    <label class="sectiontitle" for="aiPrompt">Ask AI to continue this project</label>
    <textarea id="aiPrompt" maxlength="1800" style="display:block;width:100%;min-height:75px;background:var(--glass);color:var(--text);border:1px solid var(--edge);border-radius:9px;padding:9px" placeholder="Describe the task or bug to investigate"></textarea>
    <button id="askHostAi" type="button" style="margin-top:10px;padding:9px 12px;border:1px solid var(--edge);border-radius:9px;background:var(--glass);color:var(--text);cursor:pointer">Send to connected AI chat</button>
    <button id="queueDevTask" type="button" style="margin-top:10px;padding:9px 12px;border:1px solid var(--edge);border-radius:9px;background:var(--glass);color:var(--text);cursor:pointer">Queue approved development task</button>
    <p class="note" id="aiChatNotice" role="status">Host AI chat only. Requires authenticated project snapshot and host approval. No paid cloud inference or CodeBridge job starts automatically.</p>
  </div>
</section>
<section class="panel" id="panel-work" role="tabpanel" aria-labelledby="tab-work" hidden>
  <h2 class="sectiontitle">Tracked task states</h2>
  <div class="list">
    <div class="cell"><small>In progress</small><strong id="workRunning">—</strong></div>
    <div class="cell"><small>Waiting</small><strong id="waiting">—</strong></div>
    <div class="cell"><small>Queued</small><strong id="workQueued">—</strong></div>
    <div class="cell"><small>Succeeded</small><strong id="succeeded">—</strong></div>
    <div class="cell"><small>Failed</small><strong id="failed">—</strong></div>
    <div class="cell"><small>Cancelled</small><strong id="cancelled">—</strong></div>
  </div>
  <div class="statusrow"><i aria-hidden="true"></i><span id="workHint">No authenticated task snapshot received.</span></div>
  <h2 class="sectiontitle" style="margin-top:19px">Verified operation receipts</h2>
  <p class="note" id="activityNotice">No recent job receipts requested.</p>
  <ol class="timeline" aria-label="Recent authorized project jobs">
    <li id="activity-0" hidden><i aria-hidden="true"></i><strong id="activity-title-0"></strong><time id="activity-time-0"></time></li>
    <li id="activity-1" hidden><i aria-hidden="true"></i><strong id="activity-title-1"></strong><time id="activity-time-1"></time></li>
    <li id="activity-2" hidden><i aria-hidden="true"></i><strong id="activity-title-2"></strong><time id="activity-time-2"></time></li>
    <li id="activity-3" hidden><i aria-hidden="true"></i><strong id="activity-title-3"></strong><time id="activity-time-3"></time></li>
    <li id="activity-4" hidden><i aria-hidden="true"></i><strong id="activity-title-4"></strong><time id="activity-time-4"></time></li>
    <li id="activity-5" hidden><i aria-hidden="true"></i><strong id="activity-title-5"></strong><time id="activity-time-5"></time></li>
  </ol>
  <p class="note">Recent jobs are a snapshot, not a continuously streaming feed or whole-project completion metric.</p>
</section>
<section class="panel" id="panel-evidence" role="tabpanel" aria-labelledby="tab-evidence" hidden>
  <h2 class="sectiontitle">Provenance and operating boundaries</h2>
  <dl class="detail">
    <dt>Device</dt><dd id="device">Not provided</dd>
    <dt>Project</dt><dd id="detailProject">Not provided</dd>
    <dt>Git branch</dt><dd id="branch">Not verified</dd>
    <dt>Working tree</dt><dd id="dirty">Not verified</dd>
    <dt>Git status</dt><dd id="gitEvidence">Not reported</dd>
    <dt>Task status</dt><dd id="taskEvidence">Not reported</dd>
    <dt>Capacity</dt><dd id="capacityEvidence">Not reported</dd>
    <dt>Commercial release</dt><dd>NOT EVALUATED · independent gates required</dd>
  </dl>
  <p class="note">No automatic polling, command execution, source upload or paid-model inference is performed by this view.</p>
</section>
<section class="panel" id="panel-workspace" role="tabpanel" aria-labelledby="tab-workspace" hidden>
  <h2 class="sectiontitle">Authorized File Explorer · Tracked Diff</h2>
  <div class="workspace-grid">
    <div class="files-pane">
      <strong class="sectiontitle">Project files</strong>
      <p class="note" id="workspaceFilesHint">Request includeWorkspace=true for a bounded device snapshot.</p>
      <div class="file-list" aria-label="Authorized project file names">
      <button type="button" class="file-button" id="workspace-file-0" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-1" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-2" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-3" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-4" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-5" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-6" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-7" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-8" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-9" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-10" hidden aria-pressed="false"></button>
      <button type="button" class="file-button" id="workspace-file-11" hidden aria-pressed="false"></button>
      </div>
    </div>
    <div class="diff-pane">
      <strong class="sectiontitle" id="workspaceDiffTitle">Tracked changes</strong>
      <p class="note" id="workspaceDiffHint">No verified working-tree diff requested.</p>
      <pre class="patch" id="workspaceDiff" aria-label="Redacted working-tree patch"></pre>
    </div>
  </div>
  <p class="note">Read-only. The diff excludes untracked file content. Files are bounded and may be truncated; no build, edit or script is executed in this view.</p>
</section>
<footer class="foot"><span>KMJ TECHNO · SECURE BY DESIGN</span><span><strong>Read-only snapshot</strong> · Freshness requires a new tool result</span></footer>
</article>
<script>
(function(){
 "use strict";
 var views=["overview","work","evidence","workspace"];
 var latest=null;
 function text(id,value){var el=document.getElementById(id);if(el)el.textContent=String(value===null||value===undefined?"—":value).slice(0,128);}
 // Project patches are already redacted and bounded by the scoped gateway.
 // Render plain text at that same 24-KiB limit; generic labels stay at 128.
 function patchText(value){
   var el=document.getElementById("workspaceDiff");
   if(el)el.textContent=typeof value==="string"?value.slice(0,24576):"";
 }
 function safeName(value){return typeof value==="string"&&/^[A-Za-z0-9_.:-]{1,128}$/.test(value)?value:"Not provided";}
 function count(value){return Number.isSafeInteger(value)&&value>=0&&value<=1000000?value:null;}
 function stat(value){return value===null?"—":value;}
 function setEvidence(id,valid){text(id,valid===true?"Verified":"Not reported");}
 function tab(view){
   for(var i=0;i<views.length;i++){
     var name=views[i],active=name===view;
     var t=document.getElementById("tab-"+name);
     var panel=document.getElementById("panel-"+name);
     t.setAttribute("aria-selected",String(active));t.tabIndex=active?0:-1;panel.hidden=!active;
   }
 }
 document.querySelectorAll("nav button[data-view]").forEach(function(button){
   button.addEventListener("click",function(){tab(button.getAttribute("data-view"));});
   button.addEventListener("keydown",function(event){
     var position=views.indexOf(button.getAttribute("data-view"));
     var next=event.key==="ArrowRight"?position+1:event.key==="ArrowLeft"?position-1:-1;
     if(next===-1)return;
     event.preventDefault();var view=views[(next+views.length)%views.length];
     tab(view);document.getElementById("tab-"+view).focus();
   });
 });
 function renderActivity(activity){
   var okay=activity&&activity.source==="AUTHORIZED_PROJECT_JOB_RECEIPTS"&&
     activity.status==="AVAILABLE"&&Array.isArray(activity.items)&&activity.items.length<=6;
   text("activityNotice",okay
     ? "Project-scoped job records · "+(activity.hasMore?"More entries available":"Up to six recent entries")
     : "No verified recent project-job receipts available.");
   for(var i=0;i<6;i++){
     var row=document.getElementById("activity-"+i);
     var entry=okay?activity.items[i]:null;
     var safe=entry&&typeof entry.gate==="string"&&
       /^[A-Za-z0-9_.:-]{1,100}$/.test(entry.gate)&&
       ["queued","running","succeeded","failed","cancelled","timed_out","interrupted"].indexOf(entry.state)>=0&&
       typeof entry.at==="string"&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}T/.test(entry.at);
     row.hidden=!safe;
     if(!safe)continue;
     row.setAttribute("data-state",entry.state);
     text("activity-title-"+i,entry.gate+" · "+entry.state);
     text("activity-time-"+i,entry.at);
   }
 }
 var aiMessagePending=false;
 var queuePending=false;
 var queueSerial=0;
 document.getElementById("askHostAi").addEventListener("click",function(){
   var el=document.getElementById("aiPrompt");
   var instruction=el&&typeof el.value==="string"?el.value.trim():"";
   var device=latest&&latest.device,project=latest&&latest.project;
   if(!initialized||aiMessagePending){
     text("aiChatNotice","AI chat host is not initialized or a request is pending.");return;
   }
   if(typeof device!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(device)||
      typeof project!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(project)||
      instruction.length<4||instruction.length>1800){
     text("aiChatNotice","Choose an authorized project and enter a valid instruction.");return;
   }
   aiMessagePending=true;
   text("aiChatNotice","Requesting host approval; no task queued yet.");
   window.parent.postMessage({jsonrpc:"2.0",id:2,method:"ui/message",params:{
     role:"user",content:{type:"text",text:
       "Continue authorized KMJ CodeBridge project "+project+" on "+device+
       ". Check real status and available tools before acting. Task: "+instruction+
       ". Use approved project-scoped tools only; no unapproved production cutover or paid cloud inference."}
   }},"*");
 });
 document.getElementById("queueDevTask").addEventListener("click",function(){
   var el=document.getElementById("aiPrompt");
   var instruction=el&&typeof el.value==="string"?el.value.trim():"";
   var device=latest&&latest.device,project=latest&&latest.project;
   if(!initialized||queuePending){text("aiChatNotice","Host not ready or task submission pending.");return;}
   if(typeof device!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(device)||
      typeof project!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(project)||
      instruction.length<4||instruction.length>1800){
     text("aiChatNotice","Enter a valid instruction for an authorized project.");return;
   }
   queuePending=true;
   text("aiChatNotice","Requesting permission to enqueue a project-scoped task...");
   var key="mission-ui:"+Date.now()+":"+String(++queueSerial);
   window.parent.postMessage({jsonrpc:"2.0",id:3,method:"tools/call",params:{
     name:"autopilot_enqueue",arguments:{
       device:device,project:project,key:key,objective:instruction,priority:0,dependsOn:[]
     }
   }},"*");
 });
 var selectedWorkspaceFiles=[];
 var selectedPatch=null;
 function renderSelectedFile(path){
   var selected=selectedWorkspaceFiles.indexOf(path)>=0?path:null;
   for(var i=0;i<12;i++){
     var file=document.getElementById("workspace-file-"+i);
     file.setAttribute("aria-pressed",String(file.getAttribute("data-path")===selected));
   }
   if(!selectedPatch||selected===null)return;
   var token="diff --git a/"+selected+" b/"+selected;
   var chunks=selectedPatch.split(/(?=^diff --git )/m);
   var selectedPart=null;
   for(var j=0;j<chunks.length;j++){
     if(chunks[j].indexOf(token+String.fromCharCode(10))===0||chunks[j].indexOf(token+String.fromCharCode(13,10))===0){
       selectedPart=chunks[j];break;
     }
   }
   text("workspaceDiffTitle",selected+" · Tracked changes");
   patchText(selectedPart||"No tracked diff for this file in the current bounded snapshot.");
 }
 for(var fileIndex=0;fileIndex<12;fileIndex++){
   (function(index){
     var button=document.getElementById("workspace-file-"+index);
     button.addEventListener("click",function(){
       if(!button.hidden)renderSelectedFile(button.getAttribute("data-path"));
     });
   })(fileIndex);
 }
 function renderWorkspace(workspace){
   var tree=workspace&&workspace.source==="AUTHORIZED_PROJECT_READS"&&
     workspace.tree&&workspace.tree.status==="AVAILABLE"?workspace.tree:null;
   var diff=workspace&&workspace.source==="AUTHORIZED_PROJECT_READS"&&
     workspace.diff&&workspace.diff.status==="AVAILABLE"?workspace.diff:null;
   var entries=tree&&Array.isArray(tree.entries)?tree.entries.filter(function(e){
     return e&&e.type==="file"&&typeof e.path==="string"&&e.path.length<513;
   }):[];
   selectedWorkspaceFiles=entries.slice(0,12).map(function(e){return e.path;});
   text("workspaceFilesHint",tree
     ? selectedWorkspaceFiles.length+" files shown"+(tree.truncated||entries.length>12?" · partial view":"")
     : "Request includeWorkspace=true for a verified project tree.");
   for(var i=0;i<12;i++){
     var row=document.getElementById("workspace-file-"+i);
     var entry=selectedWorkspaceFiles[i]||null;
     row.hidden=!entry;
     row.setAttribute("data-path",entry||"");
     row.setAttribute("aria-pressed","false");
     if(entry)text("workspace-file-"+i,entry);
   }
   selectedPatch=diff&&typeof diff.patch==="string"?diff.patch:null;
   text("workspaceDiffTitle","Tracked changes");
   text("workspaceDiffHint",selectedPatch!==null
     ? diff.truncated?"Tracked diff · truncated to safe UI limit":"Tracked diff · authorized repository"
     : "No verified tracked diff available.");
   patchText(selectedPatch===null?"":selectedPatch||"Working tree has no tracked changes.");
 }
 function render(input){
   var data=input&&input.structuredContent&&input.structuredContent.product==="KMJ CodeBridge"?input.structuredContent:input;
   if(!data||data.product!=="KMJ CodeBridge")return;
   latest=data;
   document.getElementById("signalPill").classList.add("has-data");
   text("signalText","SNAPSHOT RECEIVED");
   var project=safeName(data.project),device=safeName(data.device);
   text("project",project);text("detailProject",project);text("device",device);
   var tasks=data.evidence&&data.evidence.tasks===true&&data.tasks?data.tasks:null;
   var running=tasks?count(tasks.running):null,queued=tasks?count(tasks.queued):null;
   var capacity=data.evidence&&data.evidence.capacity===true?count(data.availableAuthorizedSlots):null;
   text("running",stat(running));text("queued",stat(queued));text("slots",stat(capacity));
   text("workRunning",stat(running));text("workQueued",stat(queued));
   ["waiting","succeeded","failed","cancelled"].forEach(function(key){text(key,stat(tasks?count(tasks[key]):null));});
   var gitValid=data.evidence&&data.evidence.git===true&&data.git;
   text("branch",gitValid&&typeof data.git.branch==="string"?data.git.branch:"Not verified");
   text("dirty",gitValid?(data.git.dirty?"Modified files present":"No changes reported"):"Not verified");
   setEvidence("gitEvidence",!!gitValid);setEvidence("taskEvidence",!!tasks);setEvidence("capacityEvidence",capacity!==null);
   var inspect=document.getElementById("node-inspect"),execute=document.getElementById("node-execute");
   inspect.classList.toggle("active",!!gitValid);
   execute.classList.toggle("active",running!==null&&running>0);
   execute.classList.toggle("busy",running!==null&&running>0);
   text("inspectState",gitValid?"Git state observed":"Not verified");
   text("executeState",running!==null&&running>0?"Work in progress":queued!==null&&queued>0?"Work queued":tasks?"No active jobs reported":"Not reported");
   text("verifyState","Independent CI and policy gates");
   text("nextAction",data.nextReadyTaskId?"Next ready task: "+safeName(data.nextReadyTaskId):"Next: "+safeName(data.action));
   text("workHint",tasks?"Task counts from latest authorized snapshot.":"No authenticated task snapshot received.");
   renderActivity(data.activity);
   renderWorkspace(data.workspace);
 }
 // ChatGPT's legacy bridge is optional. The portable MCP Apps protocol
 // requires a JSON-RPC initialize/initialized handshake with the parent host.
 // This view intentionally sends no tools/call and has no write capabilities.
 try{if(window.openai&&window.openai.toolOutput)render(window.openai.toolOutput);}catch(_){}
 var initializeId=1;
 var initialized=false;
 window.addEventListener("message",function(event){
   if(event.source!==window.parent)return;
   var message=event.data;
   if(!message||message.jsonrpc!=="2.0")return;
   if(message.id===initializeId){
     if(!initialized&&message.result&&message.result.protocolVersion){
       initialized=true;
       window.parent.postMessage({
         jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}
       },"*");
     }
     return;
   }
   if(message.id===3&&queuePending){
     queuePending=false;
     var ok=!message.error&&message.result&&!message.result.isError;
     text("aiChatNotice",ok?
       "Task request accepted by host; worker claim and completion NOT verified.":
       "Queue rejected or unavailable; no task acceptance was verified.");
     return;
   }
   if(message.id===2&&aiMessagePending){
     aiMessagePending=false;
     text("aiChatNotice",message.error?
       "Host denied the message. No work was started.":
       "Sent to host AI chat; execution, model and job status are not verified.");
     return;
   }
   if(message.method!=="ui/notifications/tool-result")return;
   var params=message.params||{};
   render(params.structuredContent||params.result&&params.result.structuredContent);
 });
 if(window.parent&&typeof window.parent.postMessage==="function"){
   window.parent.postMessage({
     jsonrpc:"2.0",
     id:initializeId,
     method:"ui/initialize",
     params:{
       appInfo:{name:"KMJ CodeBridge Mission Control",version:"1.0.0"},
       appCapabilities:{},
       protocolVersion:"2026-01-26"
     }
   },"*");
 }
})();
</script>
</body>
</html>`;
