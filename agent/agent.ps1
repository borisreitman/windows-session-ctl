# rdp-session-ctl agent. Runs INSIDE the interactive desktop session (started by a scheduled task with /IT),
# serves JSON commands on 127.0.0.1:$Port. Reach it from the Mac through an SSH tunnel; never expose it.
param([int]$Port=8766,[int]$TlsPort=0,[string]$Dir=(Join-Path $env:USERPROFILE 'Downloads\windows-session-ctl'))
$ErrorActionPreference='Stop'
$Version=16
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
# image search for 'check' (C# because comparing pixels in PowerShell is far too slow)
Add-Type -ReferencedAssemblies System.Drawing @'
using System; using System.Collections.Generic; using System.Drawing; using System.Drawing.Imaging; using System.Runtime.InteropServices;
public static class Img {
  public static int[] Pixels(Bitmap b){
    BitmapData d=b.LockBits(new Rectangle(0,0,b.Width,b.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
    try { int[] p=new int[b.Width*b.Height]; Marshal.Copy(d.Scan0,p,0,p.Length); return p; } finally { b.UnlockBits(d); }
  }
  static int Diff(int a,int b,int shift){ return Math.Abs(((a>>shift)&255)-((b>>shift)&255)); }
  // Every place {x,y,difference} where every opaque template pixel is within tol per colour channel. Places never
  // overlap (of overlapping candidates the closest wins) and at most max are returned, top to bottom.
  public static int[][] Find(int[] hay,int hw,int hh,int[] tpl,int tw,int th,int tol,int max){
    List<int[]> hits=new List<int[]>();
    if(tw>hw || th>hh) return hits.ToArray();
    long r=0,g=0,b=0; int n=0;
    foreach(int c in tpl){ if(((c>>24)&255)<128) continue; r+=(c>>16)&255; g+=(c>>8)&255; b+=c&255; n++; }
    if(n==0) return hits.ToArray();
    int mean=(int)(((r/n)<<16)|((g/n)<<8)|(b/n));
    // compare the most unusual pixels first, so that a wrong position is rejected quickly
    int[] key=new int[n], idx=new int[n]; int k=0;
    for(int i=0;i<tpl.Length;i++){ int c=tpl[i]; if(((c>>24)&255)<128) continue; key[k]=-(Diff(c,mean,16)+Diff(c,mean,8)+Diff(c,mean,0)); idx[k]=i; k++; }
    Array.Sort(key,idx);
    int[] want=new int[n], off=new int[n];
    for(k=0;k<n;k++){ want[k]=tpl[idx[k]]; off[k]=(idx[k]/tw)*hw+idx[k]%tw; }
    for(int y=0;y<=hh-th;y++) for(int x=0;x<=hw-tw;x++){
      int[] near=null; int overlaps=0;
      foreach(int[] h in hits) if(Math.Abs(h[0]-x)<tw && Math.Abs(h[1]-y)<th){ near=h; overlaps++; }
      if(overlaps>1 || (near!=null && near[2]==0) || (near==null && hits.Count>=max)) continue;
      int at=y*hw+x; long sum=0, limit=near==null ? long.MaxValue : near[2];
      for(k=0;k<n;k++){ int p=hay[at+off[k]], q=want[k], dr=Diff(p,q,16), dg=Diff(p,q,8), db=Diff(p,q,0);
        if(dr>tol || dg>tol || db>tol) break; sum+=dr+dg+db; if(sum>=limit) break; }
      if(k<n) continue;
      if(near==null) hits.Add(new int[]{x,y,(int)sum}); else { near[0]=x; near[1]=y; near[2]=(int)sum; }
    }
    return hits.ToArray();
  }
}
'@

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
# Every control named (or with the automation id) exactly $q that has the same parent as a control named exactly
# $text: the button in one row of a list. Siblings only, so that a label elsewhere in the window selects nothing.
function Beside($win,$q,$text){
  $named=New-Object Windows.Automation.PropertyCondition ($UIA::NameProperty,[string]$text,[Windows.Automation.PropertyConditionFlags]::IgnoreCase)
  $up=[Windows.Automation.TreeWalker]::ControlViewWalker; $found=@(); $seen=@{}
  foreach($a in $win.FindAll($Sc::Descendants,$named)){ $parent=$up.GetParent($a); if(-not $parent){ continue }
    foreach($e in $parent.FindAll($Sc::Children,$All)){ if($e.Current.Name -eq $q -or $e.Current.AutomationId -eq $q){
      $id=$e.GetRuntimeId() -join '.'; if(-not $seen.ContainsKey($id)){ $seen[$id]=$true; $found+=,$e } } } }
  ,$found }
function Walk($e,$d,$max,$cnt){ if($cnt.n -ge 800){return}; $cnt.n++; $o=Node $e; $kids=@()
  if($d -lt $max){ $w=[Windows.Automation.TreeWalker]::ControlViewWalker; $k=$w.GetFirstChild($e); while($k){ $kids+=,(Walk $k ($d+1) $max $cnt); $k=$w.GetNextSibling($k) } }
  if($kids.Count){$o.children=$kids}; $o }
function Btn($down,$up,$n=1){ for($i=0;$i -lt $n;$i++){ [W]::mouse_event($down,0,0,0,[UIntPtr]::Zero); Start-Sleep -m 40; [W]::mouse_event($up,0,0,0,[UIntPtr]::Zero); Start-Sleep -m 60 } }
function Goto($x,$y){ [W]::SetCursorPos([int]$x,[int]$y)|Out-Null; Start-Sleep -m 80 }
function Esc($t){ [regex]::Replace($t,'[+^%~(){}\[\]]','{$0}') }
function Raise($w){ try{ $h=[IntPtr]$w.Current.NativeWindowHandle; [W]::ShowWindow($h,9)|Out-Null; [W]::SetForegroundWindow($h)|Out-Null }catch{}; try{$w.SetFocus()}catch{} }
function Center($e){ $r=$e.Current.BoundingRectangle; @([int]($r.X+$r.Width/2),[int]($r.Y+$r.Height/2)) }

# Pointer guard: remember the screen geometry when the tool places the pointer, and refuse pointer-relative
# actions (click/scroll without coordinates) if the resolution changed since.
$script:Ptr=$null
function ScreenSig { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; "{0}x{1}@{2},{3}" -f $b.Width,$b.Height,$b.Left,$b.Top }
function SetPtr($x,$y){ Goto $x $y; $script:Ptr=@{sig=(ScreenSig);x=[int]$x;y=[int]$y} }
function GuardPtr($what){ if(-not $script:Ptr){ return }; $now=ScreenSig
  if($now -ne $script:Ptr.sig){ throw "screen-changed: the screen changed from $($script:Ptr.sig) to $now since the pointer was placed at ($($script:Ptr.x),$($script:Ptr.y)), so that position no longer points at the same thing. Re-check with screenshot/tree/find and move the pointer again before the $what." } }

# --- wait criteria: is a text or an image on the screen, in a window, or in a control? ('check' looks once; the CLI repeats)
$ImgDir=Join-Path $Dir 'images'; $script:Tpl=@{}; $MaxMatches=100
function ImgFile($h){ if($h -notmatch '^[0-9a-f]{64}$'){ throw 'bad image hash' }; Join-Path $ImgDir "$h.img" }
function Template($h){ if(-not $script:Tpl.ContainsKey($h)){ $b=New-Object Drawing.Bitmap (ImgFile $h)
  try{ $script:Tpl[$h]=@{p=[Img]::Pixels($b);w=$b.Width;h=$b.Height} } finally{ $b.Dispose() } }; $script:Tpl[$h] }
$g=[Drawing.Graphics]::FromHwnd([IntPtr]::Zero); $Scale=$g.DpiX/96; $g.Dispose()
function OnScreen($a){ # the part of {x,y,w,h} that is on screen, in whole pixels; $null if none is
  $c=[Drawing.Rectangle]::Intersect([Windows.Forms.SystemInformation]::VirtualScreen,(New-Object Drawing.Rectangle ([int]$a.x),([int]$a.y),([int]$a.w),([int]$a.h)))
  if($c.Width -gt 0 -and $c.Height -gt 0){ @{x=$c.X;y=$c.Y;w=$c.Width;h=$c.Height} } }
function TextRect($e,$text,$shown){ # where a text match shows: around the characters if the app says where they are,
  $q=$null                          # else the control, or just a text-sized part of a tall one
  if($e.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$q)){ try{
    $range=$q.DocumentRange.FindText($text,$false,$true)
    if($range){ $boxes=@($range.GetBoundingRectangles()); if(-not $boxes.Count){ return $null } # scrolled out of view
      $left=($boxes | % Left | Measure-Object -Minimum).Minimum; $top=($boxes | % Top | Measure-Object -Minimum).Minimum
      $right=($boxes | % Right | Measure-Object -Maximum).Maximum; $bottom=($boxes | % Bottom | Measure-Object -Maximum).Maximum
      $line=$boxes[0].Height # follows the font size
      return (OnScreen @{x=$left-$line;y=$top-$line/2;w=$right-$left+2*$line;h=$bottom-$top+$line}) }
    }catch{} } # some controls offer the pattern but cannot search it
  $r=Rect $e; if(-not $r){ return $null }
  if($r.h -gt 64*$Scale){ $r.w=[Math]::Min($r.w,[Math]::Max(160,8*[Math]::Min($shown.Length,100)+80)*$Scale); $r.h=48*$Scale } # its top left
  OnScreen $r }
function ElText($e){ $e.Current.Name; $q=$null # what an element shows: name, value, document text
  if($e.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$q)){ $q.Current.Value }
  if($e.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$q)){ $q.DocumentRange.GetText(-1) } }
function FindText($roots,$text){ # each on-screen element, in or under $roots, whose text contains $text (any case)
  $found=@(); $seen=@{}
  foreach($root in $roots){
    try{ $els=@($root)+@($root.FindAll($Sc::Descendants,$All)) }catch{ continue }
    foreach($e in $els){ if($found.Count -ge $MaxMatches){ break }
      try{ if($e.Current.IsOffscreen){ continue }
        foreach($s in (ElText $e)){ if($s -and $s.IndexOf($text,[StringComparison]::OrdinalIgnoreCase) -ge 0){
          $r=TextRect $e $text $s
          if($r){ $key="$($r.x),$($r.y),$($r.w),$($r.h)" # one entry per place
            if(-not $seen.ContainsKey($key)){ $seen[$key]=$true; $found+=,@{type=(CT $e);name=$e.Current.Name;rect=$r} } }
          break } } }catch{} } }
  ,$found }
function FindImage($el,$hash,$tol){
  $v=[Windows.Forms.SystemInformation]::VirtualScreen; $area=$v
  if($el){ $r=Rect $el; if(-not $r -or $el.Current.IsOffscreen){ return @{matches=@();reason='not on screen'} }
    $area=[Drawing.Rectangle]::Intersect($v,(New-Object Drawing.Rectangle $r.x,$r.y,$r.w,$r.h)) }
  $t=Template $hash
  if($area.Width -lt $t.w -or $area.Height -lt $t.h){ return @{matches=@();reason="the image ($($t.w)x$($t.h)) is larger than the visible area ($($area.Width)x$($area.Height))"} }
  $bmp=New-Object Drawing.Bitmap $area.Width,$area.Height
  try{ $g=[Drawing.Graphics]::FromImage($bmp); try{ $g.CopyFromScreen($area.X,$area.Y,0,0,$bmp.Size) } finally{ $g.Dispose() }
    $px=[Img]::Pixels($bmp) } finally{ $bmp.Dispose() }
  $hits=@([Img]::Find($px,$area.Width,$area.Height,$t.p,$t.w,$t.h,[int]$tol,$MaxMatches) | % { @{rect=@{x=$area.X+$_[0];y=$area.Y+$_[1];w=$t.w;h=$t.h}} })
  @{matches=$hits} }
function Shown($els){ # the controls themselves, where they are on screen
  $found=@(); foreach($e in $els){ if($found.Count -ge $MaxMatches -or $e.Current.IsOffscreen){ continue }
    $r=Rect $e; if($r){ $r=OnScreen $r }; if($r){ $found+=,@{type=(CT $e);name=$e.Current.Name;rect=$r} } }
  ,$found }
function TestCriterion($c,$tol){
  try{ $els=@()
    if($c.window){ $w=Win $c.window
      if($c.beside){ $els=Beside $w $c.control $c.beside
        if(-not $els.Count){ return @{matches=@();reason="no control matching '$($c.control)' beside '$($c.beside)'"} } }
      elseif($c.control){ $els=@(FindEl $w $c.control) } else { $els=@($w) } }
    if($c.image){ if(-not $els.Count){ return (FindImage $null $c.image $tol) }
      $r=@($els | % { FindImage $_ $c.image $tol }); return @{matches=@($r | % { $_.matches });reason=$r[0].reason} }
    if($null -eq $c.text){ return @{matches=(Shown $els)} }
    $roots=if($els.Count){ $els } else { $UIA::RootElement.FindAll($Sc::Children,$All) }
    return @{matches=(FindText $roots ([string]$c.text))}
  }catch{ $m="$($_.Exception.Message)" # a window or control may not exist (yet): that is absence, other errors are not
    return @{matches=@();reason=$m;failed=($m -notmatch '^no (window|control) matching')} } }

$M=@{
 ping       = { @{ok=$true;version=$Version} }
 info       = { $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; @{version=$Version;screen=@{w=$b.Width;h=$b.Height}; cursor=@{x=[System.Windows.Forms.Cursor]::Position.X;y=[System.Windows.Forms.Cursor]::Position.Y}; session=[Diagnostics.Process]::GetCurrentProcess().SessionId; user=$env:USERNAME; host=$env:COMPUTERNAME} }
 windows    = { $l=@(); foreach($w in $UIA::RootElement.FindAll($Sc::Children,$All)){ $c=$w.Current; if($c.Name -and -not $c.IsOffscreen){ $o=Node $w; $o.class=$c.ClassName; $o.pid=$c.ProcessId; $l+=,$o } }; ,$l }
 tree       = { param($p) $w=Win $p.window; $max=if($p.depth){[int]$p.depth}else{8}; Walk $w 0 $max @{n=0} }
 find       = { param($p) $w=Win $p.window; $l=@(); foreach($e in $w.FindAll($Sc::Descendants,$All)){ $c=$e.Current; if($c.Name -like "*$($p.query)*" -or $c.AutomationId -like "*$($p.query)*"){ $l+=,(Node $e) } }; ,$l }
 focus      = { param($p) Raise (Win $p.window); @{ok=$true} }
 invoke     = { param($p) $w=Win $p.window; Raise $w; $q=$null
              if($null -eq $p.beside){ $e=FindEl $w $p.name }
              else{ $found=Beside $w $p.name $p.beside
                if(-not $found.Count){ throw "no control matching '$($p.name)' beside '$($p.beside)'" }
                if($found.Count -gt 1){ throw "$($found.Count) controls match '$($p.name)' beside '$($p.beside)'; not choosing between them" }
                $e=$found[0] }
              if(-not $e.Current.IsEnabled){ throw "control '$($p.name)' is disabled" }
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
 mouse      = { param($p) $xy=($null -ne $p.x) -and ($null -ne $p.y)
              switch($p.action){
                'move' { if(-not $xy){throw "move needs x y"}; SetPtr $p.x $p.y }
                {$_ -in 'click','dblclick','rclick'} {
                  if($xy){ SetPtr $p.x $p.y } else { if(-not $script:Ptr){ throw "no pointer position recorded: give x y, or 'mouse move x y' first" }; GuardPtr 'click' }
                  switch($p.action){ 'click'{Btn 2 4} 'dblclick'{Btn 2 4 2} 'rclick'{Btn 8 16} } }
                'drag' { if(-not $xy){throw "drag needs x1 y1 x2 y2"}; SetPtr $p.x $p.y; [W]::mouse_event(2,0,0,0,[UIntPtr]::Zero); Start-Sleep -m 150; Goto $p.x2 $p.y2; Start-Sleep -m 100; [W]::mouse_event(4,0,0,0,[UIntPtr]::Zero); SetPtr $p.x2 $p.y2 }
                'scroll' { if($xy){ SetPtr $p.x $p.y } else { GuardPtr 'scroll' }; [W]::mouse_event(0x800,0,0,[int]$p.delta,[UIntPtr]::Zero) }
                default { throw "bad mouse action '$($p.action)'" } }
              @{ok=$true} }
 type       = { param($p) if($p.window){Raise (Win $p.window); Start-Sleep -m 250}; [Windows.Forms.SendKeys]::SendWait((Esc $p.text)); @{ok=$true} }
 key        = { param($p) if($p.window){Raise (Win $p.window); Start-Sleep -m 250}; [Windows.Forms.SendKeys]::SendWait($p.keys); @{ok=$true} }
 exec       = { param($p) $ms=if($p.timeout){[int]$p.timeout*1000}else{120000}; $utf8=New-Object Text.UTF8Encoding($false); $tmp=$null
              $si=New-Object Diagnostics.ProcessStartInfo; $si.UseShellExecute=$false; $si.CreateNoWindow=$true
              $si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true; $si.StandardOutputEncoding=$utf8; $si.StandardErrorEncoding=$utf8
              if($p.shell -eq 'cmd'){ # run as a batch file so multi-line scripts work; UTF-8 console
                $tmp=Join-Path $env:TEMP ("windows-"+[guid]::NewGuid().ToString('N')+".cmd")
                [IO.File]::WriteAllText($tmp,"@echo off`r`nchcp 65001 >nul`r`n"+(([string]$p.command) -replace "`r?`n","`r`n")+"`r`n",$utf8)
                $si.FileName=$env:ComSpec; $si.Arguments="/d /c `"`"$tmp`"`"" }
              else { $enc=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('$ProgressPreference=''SilentlyContinue''; [Console]::OutputEncoding=[Text.Encoding]::UTF8; '+[string]$p.command))
                $si.FileName='powershell.exe'; $si.Arguments="-NoProfile -ExecutionPolicy Bypass -EncodedCommand $enc" }
              try { $pr=[Diagnostics.Process]::Start($si); $o=$pr.StandardOutput.ReadToEndAsync(); $e=$pr.StandardError.ReadToEndAsync()
                if(-not $pr.WaitForExit($ms)){ try{$pr.Kill()}catch{}; @{timedOut=$true;exitCode=-1;stdout=$o.Result;stderr=$e.Result} }
                else { $pr.WaitForExit(); @{timedOut=$false;exitCode=$pr.ExitCode;stdout=$o.Result;stderr=$e.Result} } }
              finally { if($tmp){ Remove-Item $tmp -ErrorAction SilentlyContinue } } }
 launch     = { param($p) $o=@{FilePath=$p.path}; if($p.args){$o.ArgumentList=$p.args} # Start-Process rejects an empty one
              Start-Process @o; @{ok=$true} }
 putimage   = { param($p) $f=ImgFile $p.hash; $b=[Convert]::FromBase64String($p.data)
              $h=-join ([Security.Cryptography.SHA256]::Create().ComputeHash($b) | % { $_.ToString('x2') })
              if($h -ne $p.hash){ throw 'image data does not match its hash' }
              try{ (New-Object Drawing.Bitmap (New-Object IO.MemoryStream(,$b))).Dispose() }catch{ throw 'not a readable image (use PNG, BMP, GIF or JPEG)' }
              New-Item -ItemType Directory -Force $ImgDir | Out-Null; [IO.File]::WriteAllBytes($f,$b); @{ok=$true} }
 check      = { param($p) $missing=@($p.criteria | ? { $_.image -and -not (Test-Path (ImgFile $_.image)) } | % { $_.image } | Select-Object -Unique)
              if($missing.Count){ return @{missing=$missing} } # the CLI sends these with putimage, then asks again
              $res=@(); foreach($c in @($p.criteria)){ $res+=,(TestCriterion $c $p.tolerance) }
              @{missing=@();results=$res} }
 screenshot = { param($p) $v=[Windows.Forms.SystemInformation]::VirtualScreen; $area=@{x=$v.X;y=$v.Y;w=$v.Width;h=$v.Height}
              if($p.window){ $el=Win $p.window; if($p.control){ $el=FindEl $el $p.control }; $area=Rect $el; if(-not $area){ throw 'that window or control is not on screen' } }
              if($p.rect){ $o=if($p.window){ $area } else { @{x=0;y=0} } # inside a window the rect counts from its top left
                $area=@{x=$o.x+$p.rect.x;y=$o.y+$p.rect.y;w=$p.rect.w;h=$p.rect.h} }
              $c=OnScreen $area; if(-not $c){ throw 'that area is not on screen' }
              $bmp=New-Object Drawing.Bitmap $c.w,$c.h; $g=[Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($c.x,$c.y,0,0,$bmp.Size)
              $ms=New-Object IO.MemoryStream; $bmp.Save($ms,[Drawing.Imaging.ImageFormat]::Png); @{png=[Convert]::ToBase64String($ms.ToArray());w=$c.w;h=$c.h;x=$c.x;y=$c.y} }
}

# Listeners: always loopback HTTP + token (reached through SSH). With -TlsPort, also HTTPS on all interfaces that
# requires a client certificate issued by the CA in ca.crt (mutual TLS); the server certificate is bound to the port by
# the installer (netsh http add sslcert ... clientcertnegotiation=enable).
$listeners=@(); $pending=@{}
$l=New-Object Net.HttpListener; $l.Prefixes.Add("http://127.0.0.1:$Port/"); $l.Start(); $listeners+=@{id=0;l=$l;tls=$false}
$what="127.0.0.1:$Port"
$caCert=$null
# The TLS port is also remembered in tls.port, so reinstalling or upgrading over SSH keeps the mTLS listener.
$pf=Join-Path $Dir 'tls.port'
if($TlsPort -le 0 -and (Test-Path $pf) -and (Test-Path (Join-Path $Dir 'ca.crt'))){ $TlsPort=[int](Get-Content $pf -Raw).Trim() }
if($TlsPort -gt 0){
  $caCert=New-Object Security.Cryptography.X509Certificates.X509Certificate2 (Join-Path $Dir 'ca.crt')
  $l2=New-Object Net.HttpListener; $l2.Prefixes.Add("https://+:$TlsPort/"); $l2.Start(); $listeners+=@{id=1;l=$l2;tls=$true}
  $what+=" and mTLS :$TlsPort"
}
function ClientOk($cert){ # chain to the pinned CA, with clientAuth EKU; nothing else is trusted
  if(-not $cert -or -not $caCert){ return $false }
  $ch=New-Object Security.Cryptography.X509Certificates.X509Chain
  $ch.ChainPolicy.RevocationMode='NoCheck'; $ch.ChainPolicy.VerificationFlags='AllowUnknownCertificateAuthority'
  [void]$ch.ChainPolicy.ExtraStore.Add($caCert)
  if(-not $ch.Build($cert)){ return $false }
  foreach($st in $ch.ChainStatus){ if($st.Status -notin 'NoError','UntrustedRoot'){ return $false } }
  $n=$ch.ChainElements.Count; if($n -lt 2){ return $false }
  if($ch.ChainElements[$n-1].Certificate.Thumbprint -ne $caCert.Thumbprint){ return $false }
  $eku=$cert.Extensions | ? { $_ -is [Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] }
  return [bool]($eku -and ($eku.EnhancedKeyUsages | ? { $_.Value -eq '1.3.6.1.5.5.7.3.2' }))
}
"agent listening on $what session=$([Diagnostics.Process]::GetCurrentProcess().SessionId) version=$Version" | Set-Content (Join-Path $Dir 'agent.log')
while($true){
  foreach($x in $listeners){ if(-not $pending.ContainsKey($x.id)){ $pending[$x.id]=$x.l.GetContextAsync() } }
  $i=[Threading.Tasks.Task]::WaitAny([Threading.Tasks.Task[]]@($listeners | % { $pending[$_.id] }))
  $x=$listeners[$i]; $c=$pending[$x.id].Result; $pending.Remove($x.id)
  $rs=$c.Response; $code=200
  try {
    $authed=$false
    if($x.tls){ try{ $authed=ClientOk $c.Request.GetClientCertificate() }catch{ $authed=$false }; if(-not $authed){ $code=401; $out=@{ok=$false;error='client certificate required'} } }
    elseif($c.Request.Headers['X-Token'] -eq $token){ $authed=$true } else { $code=401; $out=@{ok=$false;error='bad token'} }
    if($authed){
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
