// PowerShell that `az vm run-command` runs on the VM (as SYSTEM, session 0). Only public material is embedded:
// the agent script, the CA certificate and the signed server certificate. No private key is ever sent.
const q = (s) => String(s).replace(/'/g, "''");
// run-command loses terminating errors easily, so every script reports them on stdout.
const guarded = (body) => `try {\n${body}\n} catch { "WSC-ERROR: $($_.Exception.Message)" }\n`;

// Step 1: create the server key on the VM (machine store, non-exportable) and print a certificate signing request.
export function csrScript(fqdn) {
  return guarded(`$ErrorActionPreference='Stop'
$w='C:\\Windows\\Temp\\wsc'; New-Item -ItemType Directory -Force $w | Out-Null
$inf = @"
[NewRequest]
Subject = "CN=${fqdn}"
KeyAlgorithm = ECDSA_P256
KeyLength = 256
MachineKeySet = TRUE
Exportable = FALSE
RequestType = PKCS10
KeyUsage = 0x80
ProviderName = "Microsoft Software Key Storage Provider"
"@
Set-Content "$w\\req.inf" $inf -Encoding ASCII
Remove-Item "$w\\req.csr" -ErrorAction SilentlyContinue
$o = certreq -new -q "$w\\req.inf" "$w\\req.csr" 2>&1
if(-not (Test-Path "$w\\req.csr")){ throw "certreq -new failed: $o" }
"CSR-BEGIN"; (Get-Content "$w\\req.csr" -Raw).Trim(); "CSR-END"`);
}

const restart = (tn) => `
schtasks /End /TN ${tn} 2>&1 | Out-Null
Remove-Item "$dir\\agent.log" -ErrorAction SilentlyContinue
$o = schtasks /Run /TN ${tn} 2>&1; if($LASTEXITCODE -ne 0){ throw "schtasks /Run failed: $o" }
for($i=0;$i -lt 30;$i++){ Start-Sleep 1; if((Test-Path "$dir\\agent.log") -and ((Get-Content "$dir\\agent.log" -Raw) -match 'listening')){ break } }
if(-not (Test-Path "$dir\\agent.log")){ throw "the agent did not start: is $user logged in on the desktop?" }
"AGENT-LOG: " + (Get-Content "$dir\\agent.log" -Raw).Trim()
`;

// Step 2: install the signed certificate, bind it to the port with client-certificate negotiation, open the Windows
// firewall port, write the agent and register + start the logon task. Does not touch any Azure NSG.
export function installScript({ user, port, agentB64, caB64, certB64 }) {
  return guarded(`$ErrorActionPreference='Stop'
$user='${q(user)}'; $port=${Number(port)}; $tn='windows-agent'
$dir="C:\\Users\\$user\\Downloads\\windows-session-ctl"
New-Item -ItemType Directory -Force $dir | Out-Null
[IO.File]::WriteAllBytes("$dir\\agent.ps1",[Convert]::FromBase64String('${agentB64}'))
[IO.File]::WriteAllBytes("$dir\\ca.crt",[Convert]::FromBase64String('${caB64}'))
Set-Content "$dir\\tls.port" $port -Encoding ASCII
New-Item -ItemType Directory -Force 'C:\\Windows\\Temp\\wsc' | Out-Null
$cer='C:\\Windows\\Temp\\wsc\\server.cer'
[IO.File]::WriteAllBytes($cer,[Convert]::FromBase64String('${certB64}'))
$thumb = (New-Object Security.Cryptography.X509Certificates.X509Certificate2 $cer).Thumbprint
# Add the certificate and link it to the key created in step 1. (Not \`certreq -accept\`: that insists the issuing CA be a
# trusted root on the VM, which we deliberately avoid, and shows an invisible dialog in session 0.)
$o = certutil -f -addstore My $cer 2>&1; if($LASTEXITCODE -ne 0){ throw "certutil -addstore failed: $o" }
$o = certutil -f -repairstore My $thumb 2>&1; if($LASTEXITCODE -ne 0){ throw "certutil -repairstore failed: $o" }
$c = Get-Item "Cert:\\LocalMachine\\My\\$thumb" -ErrorAction SilentlyContinue
if(-not $c -or -not $c.HasPrivateKey){ throw "certificate installed without its private key (run the install again): $o" }
# drop certificates from earlier installs of this tool
Get-ChildItem Cert:\\LocalMachine\\My | Where-Object { $_.Issuer -eq 'CN=windows-session-ctl CA' -and $_.Thumbprint -ne $thumb } | Remove-Item
netsh http delete sslcert ipport=0.0.0.0:$port 2>&1 | Out-Null
$o = netsh http add sslcert ipport=0.0.0.0:$port certhash=$thumb appid='{6f1c0a52-5b0e-4c1e-9a43-8a6f5d0c7e21}' clientcertnegotiation=enable 2>&1
if($LASTEXITCODE -ne 0){ throw "netsh http add sslcert failed: $o" }
netsh http delete urlacl url=https://+:$port/ 2>&1 | Out-Null
netsh http add urlacl url=https://+:$port/ user="$env:COMPUTERNAME\\$user" 2>&1 | Out-Null
netsh advfirewall firewall delete rule name='windows-session-ctl agent' 2>&1 | Out-Null
netsh advfirewall firewall add rule name='windows-session-ctl agent' dir=in action=allow protocol=TCP localport=$port 2>&1 | Out-Null
schtasks /End /TN $tn 2>&1 | Out-Null; schtasks /Delete /TN $tn /F 2>&1 | Out-Null
$tr = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \`"$dir\\agent.ps1\`""
$o = schtasks /Create /TN $tn /F /SC ONLOGON /RU $user /IT /RL HIGHEST /TR $tr 2>&1; if($LASTEXITCODE -ne 0){ throw "schtasks /Create failed: $o" }
"CERT-THUMBPRINT: $thumb"
${restart("$tn")}`);
}

// Upgrade: replace agent.ps1 and restart the existing task (certificate, binding and task stay as they are).
export function upgradeScript({ user, port, agentB64 }) {
  return guarded(`$ErrorActionPreference='Stop'
$user='${q(user)}'; $tn='windows-agent'
$dir="C:\\Users\\$user\\Downloads\\windows-session-ctl"
if(-not (Test-Path "$dir\\agent.ps1")){ throw "no agent installed in $dir - run install first" }
Set-Content "$dir\\tls.port" ${Number(port)} -Encoding ASCII
[IO.File]::WriteAllBytes("$dir\\agent.ps1",[Convert]::FromBase64String('${agentB64}'))
${restart("$tn")}`);
}
