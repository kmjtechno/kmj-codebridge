param(
    [Parameter(Mandatory)][ValidateSet('Inspect','Invoke')][string]$Mode,
    [Parameter(Mandatory)][string]$TargetExe,
    [ValidatePattern('^[A-Za-z0-9_.-]{1,80}$')][string]$AutomationId,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$ExecutableSha256
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'

# Only a locally reviewed profile may select the executable and action.
# No arbitrary global mouse/keyboard input, process launch or window activation.
function Require([bool]$Condition,[string]$Code) {
    if(!$Condition){throw $Code}
}
function OrdinaryExe([string]$Path) {
    Require ([IO.Path]::IsPathRooted($Path) -and $Path -match '^[A-Za-z]:\\') 'DESKTOP_TARGET_PATH'
    $file=Get-Item -LiteralPath $Path -Force
    Require ($file -is [IO.FileInfo] -and $file.Extension -ieq '.exe') 'DESKTOP_TARGET_TYPE'
    $cursor=$file
    while($null -ne $cursor){
        Require (!(($cursor.Attributes -band [IO.FileAttributes]::ReparsePoint))) 'DESKTOP_REPARSE_DENIED'
        if($cursor -is [IO.FileInfo]){$cursor=$cursor.Directory}
        else{$cursor=$cursor.Parent}
    }
    return $file.FullName
}
function AssertInteractive {
    $session=[Diagnostics.Process]::GetCurrentProcess().SessionId
    Require ($session -gt 0 -and [Environment]::UserInteractive) 'DESKTOP_INTERACTIVE_SESSION_REQUIRED'
    $desktop=[KMJDesktopNative]::OpenInputDesktop(0,$false,1)
    Require ($desktop -ne [IntPtr]::Zero) 'DESKTOP_INPUT_UNAVAILABLE'
    try{
        $name=New-Object Text.StringBuilder 128
        $needed=0
        Require ([KMJDesktopNative]::GetUserObjectInformation($desktop,2,$name,256,[ref]$needed)) 'DESKTOP_NAME_UNVERIFIED'
        Require ($name.ToString() -ieq 'Default') 'DESKTOP_NOT_DEFAULT'
    }finally{[void][KMJDesktopNative]::CloseDesktop($desktop)}
    return $session
}
function TargetWindow([string]$Path,[int]$Session) {
    $handle=[KMJDesktopNative]::GetForegroundWindow()
    Require ($handle -ne [IntPtr]::Zero) 'DESKTOP_FOREGROUND_REQUIRED'
    [uint32]$targetPid=0
    [void][KMJDesktopNative]::GetWindowThreadProcessId($handle,[ref]$targetPid)
    Require ($targetPid -gt 0) 'DESKTOP_PID_UNVERIFIED'
    $p=Get-Process -Id $targetPid -ErrorAction Stop
    Require ($p.SessionId -eq $Session -and $p.Path -ieq $Path) 'DESKTOP_FOREGROUND_NOT_APPROVED_TARGET'
    Require ([KMJDesktopNative]::IsWindowVisible($handle) -and ![KMJDesktopNative]::IsIconic($handle)) 'DESKTOP_WINDOW_NOT_VISIBLE'
    $element=[Windows.Automation.AutomationElement]::FromHandle($handle)
    Require ($null -ne $element -and $element.Current.ProcessId -eq $targetPid) 'DESKTOP_UIA_ROOT_UNVERIFIED'
    return @{Handle=$handle;Pid=$targetPid;Element=$element;Started=$p.StartTime.ToUniversalTime().Ticks}
}
try {
    Require (($Mode -eq 'Inspect' -and !$AutomationId -and !$ExecutableSha256) -or ($Mode -eq 'Invoke' -and $AutomationId -and $ExecutableSha256)) 'DESKTOP_MODE_SCOPE'
    $approved=OrdinaryExe $TargetExe
    Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class KMJDesktopNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder name,int length,out int needed);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
}
'@
    $session=AssertInteractive
    $target=TargetWindow $approved $session
    if($Mode -eq 'Invoke'){
        Require ((Get-FileHash -LiteralPath $approved -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExecutableSha256) 'DESKTOP_EXECUTABLE_HASH_CHANGED'
    }
    # Enumerate only this exact window's same-process controls, never a
    # desktop-wide tree. Bound work; fail closed on ambiguous action matches.
    $walker=[Windows.Automation.TreeWalker]::ControlViewWalker
    $queue=New-Object 'System.Collections.Generic.Queue[object]'
    $first=$walker.GetFirstChild($target.Element)
    if($null -ne $first){$queue.Enqueue($first)}
    $seen=0
    $invokable=0
    $matches=New-Object 'System.Collections.Generic.List[object]'
    $partial=$false
    while($queue.Count -gt 0){
        if($seen -ge 200){$partial=$true;break}
        $node=$queue.Dequeue()
        $seen++
        $sibling=$walker.GetNextSibling($node)
        if($null -ne $sibling){$queue.Enqueue($sibling)}
        if($node.Current.ProcessId -ne $target.Pid){continue}
        $child=$walker.GetFirstChild($node)
        if($null -ne $child){$queue.Enqueue($child)}
        $pattern=$null
        if($node.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){
            $invokable++
            if($Mode -eq 'Invoke' -and $node.Current.AutomationId -ceq $AutomationId){
                $matches.Add($node)
            }
        }
    }
    if($Mode -eq 'Inspect'){
        Write-Output ('DESKTOP_CONTROLS='+$seen)
        Write-Output ('DESKTOP_INVOKABLE_CONTROLS='+$invokable)
        Write-Output ('DESKTOP_COVERAGE_PARTIAL='+[int]$partial)
        Write-Output 'DESKTOP_TARGET_WINDOW=PASS'
        Write-Output 'DESKTOP_INPUT=NOT_ATTEMPTED'
        exit 0
    }
    Require (!$partial -and $matches.Count -eq 1) 'DESKTOP_CONTROL_NOT_UNIQUE'
    $node=$matches[0]
    Require ($node.Current.IsEnabled -and !$node.Current.IsOffscreen -and $node.Current.ProcessId -eq $target.Pid) 'DESKTOP_CONTROL_UNAVAILABLE'
    # Recheck desktop, foreground process lifetime and exact control identity
    # immediately before the single UIA invoke. Never switch focus.
    $again=TargetWindow $approved (AssertInteractive)
    Require ($again.Handle -eq $target.Handle -and $again.Pid -eq $target.Pid -and $again.Started -eq $target.Started) 'DESKTOP_TARGET_CHANGED'
    Require ($node.Current.AutomationId -ceq $AutomationId) 'DESKTOP_CONTROL_CHANGED'
    Require ((Get-FileHash -LiteralPath $approved -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $ExecutableSha256) 'DESKTOP_EXECUTABLE_HASH_CHANGED'
    $pattern=$null
    Require ($node.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) 'DESKTOP_INVOKE_UNAVAILABLE'
    ([Windows.Automation.InvokePattern]$pattern).Invoke()
    Write-Output 'DESKTOP_INVOKE_REQUEST=PASS'
    Write-Output 'DESKTOP_ACTION_EFFECT=NOT_VERIFIED'
}catch{
    # Do not leak window titles, control text, private paths or exception bodies.
    $code=$_.Exception.Message
    if($code -notmatch '^DESKTOP_[A-Z_]+$'){$code='DESKTOP_UIA_UNVERIFIED'}
    Write-Output ('DESKTOP_BLOCKED='+$code)
    exit 1
}
