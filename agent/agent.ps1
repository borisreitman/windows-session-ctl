# rdp-session-ctl agent. Runs INSIDE the interactive desktop session (started by a scheduled task with /IT),
# serves JSON commands on 127.0.0.1:$Port. Reach it from the Mac through an SSH tunnel; never expose it.
param([int]$Port=8766,[string]$Dir='C:\uiauto')
$ErrorActionPreference='Stop'
$Version=2
New-Item -ItemType Directory -Force $Dir | Out-Null
Add-Type -AssemblyName System.Windows.Forms,System.Drawing,UIAutomationClient,UIAutomationTypes
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f,int dx,int dy,int d,UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
}
'@
[W]::SetProcessDPIAware() | Out-Null

# --- auth token (file readable only by this user's profile dir via ACL inheritance of $Dir is not enough; restrict it) ---
$token=[guid]::NewGuid().ToString('N')
$tf=Join-Path $Dir 'token'; Set-Content $tf $token -NoNewline
icacls $tf /inheritance:r /grant:r "$($env:USERNAME):(R,W)" 'SYSTEM:(R)' | Out-Null

$UIA=[Windows.Automation.AutomationElement]; $Sc=[Windows.Automation.TreeScope]; $All=[Windows.Automation.Condition]::TrueCondition
function Rect($e){ $r=$e.Current.BoundingRectangle; if($r.IsEmpty -or [double]::IsInfinity($r.X)){return $null}; @{x=[int]$r.X;y=[int]$r.Y;w=[int]$r.Width;h=[int]$r.Height} }
function CT($e){ $e.Current.ControlType.ProgrammaticName -replace 'ControlType\.','' }
function Node($e){ $c=$e.Current; $o=[ordered]@{type=(CT $e);name=$c.Name}; if($c.AutomationId){$o.id=$c.AutomationId}; $r=Rect $e; if($r){$o.rect=$r}; if(-not $c.IsEnabled){$o.disabled=$true}; $o }
function Win($t){ foreach($w in $UIA::RootElement.FindAll($Sc::Children,$All)){ if($w.Current.Name -eq $t){return $w} }
  foreach($w in $UIA::RootElement.FindAll($Sc::Children,$All)){ if($w.Current.Name -like "*$t*"){return $w} }; throw "no window matching '$t'" }
function FindEl($win,$q){
  $d=$win.FindAll($Sc::Descendants,$All)
  if($q -eq '*'){ foreach($e in $d){ if((CT $e) -match '^(Edit|Document)$'){return $e} } }
  else { foreach($e in $d){ if($e.Current.Name -eq $q -or $e.Current.AutomationId -eq $q){return $e} }
         foreach($e in $d){ if($e.Current.Name -like "*$q*"){return $e} } }
  throw "no control matching '$q'" }
function Walk($e,$d,$max,$cnt){ if($cnt.n -ge 800){return}; $cnt.n++; $o=Node $e; $kids=@()
  if($d -lt $max){ $w=[Windows.Automation.TreeWalker]::ControlViewWalker; $k=$w.GetFirstChild($e); while($k){ $kids+=,(Walk $k ($d+1) $max $cnt); $k=$w.GetNextSibling($k) } }
  if($kids.Count){$o.children=$kids}; $o }
function Btn($down,$up,$n=1){ for($i=0;$i -lt $n;$i++){ [W]::mouse_event($down,0,0,0,[UIntPtr]::Zero); Start-Sleep -m 40; [W]::mouse_event($up,0,0,0,[UIntPtr]::Zero); Start-Sleep -m 60 } }
function Goto($x,$y){ [W]::SetCursorPos([int]$x,[int]$y)|Out-Null; Start-Sleep -m 80 }
function Esc($t){ [regex]::Replace($t,'[+^%~(){}\[\]]','{$0}') }
function Raise($w){ try{ $h=[IntPtr]$w.Current.NativeWindowHandle; [W]::ShowWindow($h,9)|Out-Null; [W]::SetForegroundWindow($h)|Out-Null }catch{}; try{$w.SetFocus()}catch{} }
function Center($e){ $r=$e.Current.BoundingRectangle; @([int]($r.X+$r.Width/2),[int]($r.Y+$r.Height/2)) }

$M=@{
 ping       = { @{ok=$true;version=$Version} }
 info       = { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; @{version=$Version;screen=@{w=$b.Width;h=$b.Height}; cursor=@{x=[System.Windows.Forms.Cursor]::Position.X;y=[System.Windows.Forms.Cursor]::Position.Y}; session=[Diagnostics.Process]::GetCurrentProcess().SessionId; user=$env:USERNAME; host=$env:COMPUTERNAME} }
 windows    = { $l=@(); foreach($w in $UIA::RootElement.FindAll($Sc::Children,$All)){ $c=$w.Current; if($c.Name -and -not $c.IsOffscreen){ $o=Node $w; $o.class=$c.ClassName; $o.pid=$c.ProcessId; $l+=,$o } }; ,$l }
 tree       = { param($p) $w=Win $p.window; $max=if($p.depth){[int]$p.depth}else{8}; Walk $w 0 $max @{n=0} }
 find       = { param($p) $w=Win $p.window; $l=@(); foreach($e in $w.FindAll($Sc::Descendants,$All)){ $c=$e.Current; if($c.Name -like "*$($p.query)*" -or $c.AutomationId -like "*$($p.query)*"){ $l+=,(Node $e) } }; ,$l }
 focus      = { param($p) Raise (Win $p.window); @{ok=$true} }
 invoke     = { param($p) $w=Win $p.window; Raise $w; $e=FindEl $w $p.name; $q=$null
              if($e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$q)){$q.Invoke();@{via='invoke'}}
              elseif($e.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$q)){$q.Toggle();@{via='toggle'}}
              elseif($e.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$q)){$q.Select();@{via='select'}}
              elseif($e.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$q)){$q.Expand();@{via='expand'}}
              else{ $c=Center $e; Goto $c[0] $c[1]; Btn 2 4; @{via='click-center'} } }
 settext    = { param($p) $w=Win $p.window; Raise $w; $e=FindEl $w $(if($p.name){$p.name}else{'*'}); $q=$null; try{$e.SetFocus()}catch{}
              if($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$q) -and -not $q.Current.IsReadOnly){ $q.SetValue([string]$p.text); @{via='value'} }
              else{ Start-Sleep -m 200; [Windows.Forms.SendKeys]::SendWait('^a'); [Windows.Forms.SendKeys]::SendWait((Esc $p.text)); @{via='keys'} } }
 gettext    = { param($p) $w=Win $p.window; $e=FindEl $w $(if($p.name){$p.name}else{'*'}); $q=$null
              if($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$q)){@{text=$q.Current.Value}}
              elseif($e.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$q)){@{text=$q.DocumentRange.GetText(-1)}}
              else{@{text=$e.Current.Name}} }
 mouse      = { param($p) switch($p.action){
                'move'{Goto $p.x $p.y} 'click'{Goto $p.x $p.y;Btn 2 4} 'dblclick'{Goto $p.x $p.y;Btn 2 4 2} 'rclick'{Goto $p.x $p.y;Btn 8 16}
                'drag'{Goto $p.x $p.y;[W]::mouse_event(2,0,0,0,[UIntPtr]::Zero);Start-Sleep -m 150;Goto $p.x2 $p.y2;Start-Sleep -m 100;[W]::mouse_event(4,0,0,0,[UIntPtr]::Zero)}
                'scroll'{[W]::mouse_event(0x800,0,0,[int]$p.delta,[UIntPtr]::Zero)} default{throw "bad mouse action"} }; @{ok=$true} }
 type       = { param($p) if($p.window){Raise (Win $p.window); Start-Sleep -m 250}; [Windows.Forms.SendKeys]::SendWait((Esc $p.text)); @{ok=$true} }
 key        = { param($p) if($p.window){Raise (Win $p.window); Start-Sleep -m 250}; [Windows.Forms.SendKeys]::SendWait($p.keys); @{ok=$true} }
 launch     = { param($p) Start-Process -FilePath $p.path -ArgumentList $p.args; @{ok=$true} }
 screenshot = { param($p) $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; $x=$b.Left;$y=$b.Top;$w=$b.Width;$h=$b.Height
              if($p.window){ $r=(Win $p.window).Current.BoundingRectangle; $x=[Math]::Max($b.Left,[int]$r.X);$y=[Math]::Max($b.Top,[int]$r.Y);$w=[int]$r.Width;$h=[int]$r.Height }
              $bmp=New-Object Drawing.Bitmap $w,$h; $g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($x,$y,0,0,$bmp.Size)
              $ms=New-Object IO.MemoryStream; $bmp.Save($ms,[Drawing.Imaging.ImageFormat]::Png); @{png=[Convert]::ToBase64String($ms.ToArray());w=$w;h=$h;x=$x;y=$y} }
}

$l=New-Object Net.HttpListener; $l.Prefixes.Add("http://127.0.0.1:$Port/"); $l.Start()
"agent listening on 127.0.0.1:$Port session=$([Diagnostics.Process]::GetCurrentProcess().SessionId)" | Set-Content (Join-Path $Dir 'agent.log')
while($l.IsListening){
  $c=$l.GetContext(); $rs=$c.Response; $code=200
  try {
    if($c.Request.Headers['X-Token'] -ne $token){ $code=401; $out=@{ok=$false;error='bad token'} }
    else {
      $body=(New-Object IO.StreamReader($c.Request.InputStream,[Text.Encoding]::UTF8)).ReadToEnd()
      $req=$body | ConvertFrom-Json
      if(-not $M.ContainsKey($req.method)){ throw "unknown method '$($req.method)'" }
      $res=& $M[$req.method] $req.params
      $out=@{ok=$true;result=$res}
    }
  } catch { $code=500; $out=@{ok=$false;error="$($_.Exception.Message)"} }
  $bytes=[Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Depth 30 -Compress))
  $rs.StatusCode=$code; $rs.ContentType='application/json'; $rs.ContentLength64=$bytes.Length; $rs.OutputStream.Write($bytes,0,$bytes.Length); $rs.Close()
}
