# Minimal init script for the Windows 11 VM (runs once via the Terraform extension).
# Only sets up what is needed to log in: RDP, Chocolatey, user profile,
# authorized_keys and OpenSSH. Everything else (dev tools and so on) is up to you.

param(
    [string]$SshPublicKey = "REPLACE_WITH_YOUR_SSH_PUBLIC_KEY",
    [string]$AdminUser = "azureuser"
)

$ErrorActionPreference = 'Stop'

function Write-Log {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [object[]]$Message
    )
    $text = ($Message | ForEach-Object { "$_" }) -join ' '
    if ($text -eq '') {
        Write-Host ''
        return
    }
    Write-Host ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $text)
    [Console]::Out.Flush()
}

function Write-Cmd {
    param([string]$CommandLine)
    Write-Log ('[CMD] {0}' -f $CommandLine)
}

function Write-Step {
    param(
        [string]$Step,
        [Parameter(ValueFromRemainingArguments = $true)]
        [object[]]$Message
    )
    $text = ($Message | ForEach-Object { "$_" }) -join ' '
    Write-Log ('[{0}] {1}' -f $Step, $text)
}

function Invoke-LoggedStep {
    param(
        [string]$Step,
        [string]$Description,
        [scriptblock]$Action
    )

    Write-Step $Step ('BEGIN {0}' -f $Description)
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        & $Action
        $sw.Stop()
        Write-Step $Step ('DONE {0} ({1}s)' -f $Description, [math]::Round($sw.Elapsed.TotalSeconds))
    } catch {
        $sw.Stop()
        Write-Step $Step ('FAILED {0} ({1}s): {2}' -f $Description, [math]::Round($sw.Elapsed.TotalSeconds), $_.Exception.Message)
        throw
    }
}

function Get-OpenSshBinDir {
    $candidates = @(
        'C:\Program Files\OpenSSH-Win64'
        'C:\Program Files\OpenSSH'
    )
    foreach ($dir in $candidates) {
        if (Test-Path (Join-Path $dir 'sshd.exe')) {
            return $dir
        }
    }
    return $null
}

function Install-Chocolatey {
    param([string]$Step)

    $chocoExe = 'C:\ProgramData\chocolatey\bin\choco.exe'
    if (Test-Path $chocoExe) {
        Write-Step $Step 'Chocolatey already installed'
        return
    }

    Write-Cmd 'Install Chocolatey (community install.ps1)'
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
}

function New-UserProfileIfMissing {
    param(
        [string]$Step,
        [string]$UserName
    )

    # The extension runs at provisioning time, before anyone has logged in, so
    # C:\Users\<user> does not exist yet. Create it through the same Win32 API
    # Windows uses at first logon (a bare New-Item would make Windows create a
    # "<user>.<HOSTNAME>" profile at first logon instead).
    $account = New-Object System.Security.Principal.NTAccount($UserName)
    $sid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value

    if (-not ('UserProfileNative' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UserProfileNative {
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = false)]
    public static extern int CreateProfile(string pszUserSid, string pszUserName, StringBuilder pszProfilePath, uint cchProfilePath);
}
'@
    }

    Write-Cmd ('CreateProfile({0}, {1})' -f $sid, $UserName)
    $path = New-Object System.Text.StringBuilder 260
    $hr = [UserProfileNative]::CreateProfile($sid, $UserName, $path, 260)
    # 0x800700B7 = ERROR_ALREADY_EXISTS (profile was created in the meantime)
    if ($hr -ne 0 -and $hr -ne -2147024713) {
        throw ('CreateProfile failed for {0}: HRESULT 0x{1:X8}' -f $UserName, $hr)
    }
    Write-Step $Step ('Profile ready: {0}' -f $path.ToString())
}

function Install-AuthorizedKey {
    param([string]$Step)

    $userProfile = Join-Path 'C:\Users' $AdminUser
    if (!(Test-Path $userProfile)) {
        Write-Step $Step ('User profile not found: {0}; creating it' -f $userProfile)
        New-UserProfileIfMissing -Step $Step -UserName $AdminUser
    }
    if (!(Test-Path $userProfile)) {
        throw ('User profile still not found after CreateProfile: {0}' -f $userProfile)
    }

    $userSshDir = Join-Path $userProfile '.ssh'
    $authorizedKeys = Join-Path $userSshDir 'authorized_keys'

    Write-Cmd ('New-Item -ItemType Directory -Force -Path "{0}"' -f $userSshDir)
    New-Item -ItemType Directory -Force -Path $userSshDir | Out-Null

    Write-Cmd ('Set-Content -Path "{0}" -Value <ssh-public-key>' -f $authorizedKeys)
    Set-Content -Path $authorizedKeys -Value $SshPublicKey -NoNewline -Encoding ASCII
    Write-Step $Step ('Wrote {0}' -f $authorizedKeys)

    Write-Cmd ('icacls.exe "{0}" ...' -f $userSshDir)
    $aclResult1 = icacls.exe $userSshDir /inheritance:r /grant:r ('{0}:(OI)(CI)R' -f $AdminUser) /grant:r 'Administrators:(OI)(CI)R' /grant:r 'SYSTEM:(OI)(CI)F' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ('ACL on directory failed: {0}' -f $aclResult1)
    }

    $aclResult2 = icacls.exe $authorizedKeys /inheritance:r /grant:r ('{0}:R' -f $AdminUser) /grant:r 'Administrators:R' /grant:r 'SYSTEM:F' 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw ('ACL on authorized_keys failed: {0}' -f $aclResult2)
    }
}

function Set-OpenSshFirewallRule {
    param([string]$Step)

    # Chocolatey installs OpenSSH-Win64. OpenSSH-Server-In-TCP from install-sshd.ps1
    # only allows System32\OpenSSH\sshd.exe and blocks remote access to Win64 sshd.
    $sshdExe = 'C:\Program Files\OpenSSH-Win64\sshd.exe'
    Write-Cmd ('New-NetFirewallRule -Name OpenSSH-Server-Win64 -Program "{0}" -LocalPort 22' -f $sshdExe)
    New-NetFirewallRule -Name 'OpenSSH-Server-Win64' -DisplayName 'OpenSSH Server Win64' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -Program $sshdExe -Profile Any | Out-Null
}

function Install-OpenSshServer {
    param([string]$Step)

    $chocoExe = 'C:\ProgramData\chocolatey\bin\choco.exe'
    if (!(Test-Path $chocoExe)) {
        throw 'Chocolatey not found'
    }

    $binDir = Get-OpenSshBinDir
    if ($binDir) {
        Write-Step $Step ('OpenSSH binaries already present at {0}' -f $binDir)
    } else {
        Write-Cmd ('{0} install openssh -y --no-progress --debug' -f $chocoExe)
        & $chocoExe install openssh -y --no-progress --debug
        if ($LASTEXITCODE -ne 0) {
            throw ('Chocolatey openssh install failed with exit code {0}' -f $LASTEXITCODE)
        }

        $binDir = Get-OpenSshBinDir
        if (-not $binDir) {
            throw 'Chocolatey finished but sshd.exe not found'
        }
        Write-Step $Step ('OpenSSH installed at {0}' -f $binDir)
    }

    $sshd = Get-Service sshd -ErrorAction SilentlyContinue
    if (-not $sshd) {
        $installScript = Join-Path $binDir 'install-sshd.ps1'
        Write-Cmd ('powershell.exe -ExecutionPolicy Bypass -File "{0}"' -f $installScript)
        & powershell.exe -ExecutionPolicy Bypass -File $installScript | Out-Null
    }
}

Write-Log 'Starting setup script'

# =============================================================================
# PHASE 1: RDP, Chocolatey, Windows SDK PATH, SSH
# =============================================================================
Write-Log '=== RDP + Chocolatey + SSH ==='

Invoke-LoggedStep '1.1' 'Enable RDP' {
    Write-Cmd 'Set-ItemProperty fDenyTSConnections=0; Enable-NetFirewallRule Remote Desktop'
    Set-ItemProperty -Path 'HKLM:\System\CurrentControlSet\Control\Terminal Server' -name 'fDenyTSConnections' -value 0
    Enable-NetFirewallRule -DisplayGroup 'Remote Desktop'
}

Invoke-LoggedStep '1.2' 'Install Chocolatey' {
    Install-Chocolatey -Step '1.2'
}

Invoke-LoggedStep '1.3' 'Install authorized_keys' {
    Install-AuthorizedKey -Step '1.3'
}

Invoke-LoggedStep '1.4' 'Install OpenSSH Server via Chocolatey' {
    Install-OpenSshServer -Step '1.4'
}

Invoke-LoggedStep '1.5' 'Enable and start sshd service' {
    Write-Cmd 'Set-Service -Name sshd -StartupType Automatic; Start-Service sshd'
    Set-Service -Name sshd -StartupType Automatic
    Start-Service sshd
    $sshService = Get-Service sshd -ErrorAction SilentlyContinue
    if (-not $sshService -or $sshService.Status -ne 'Running') {
        throw 'sshd service is not running after start'
    }
    Write-Step '1.5' ('sshd status: {0}' -f $sshService.Status)
}

Invoke-LoggedStep '1.6' 'Write sshd_config for key-based auth' {
    $sshConfigDir = 'C:\ProgramData\ssh'
    $sshdConfigPath = Join-Path $sshConfigDir 'sshd_config'
    if (!(Test-Path $sshConfigDir)) {
        New-Item -ItemType Directory -Force -Path $sshConfigDir | Out-Null
    }

    $sshdConfig = @'
LogLevel INFO
SyslogFacility AUTH
PasswordAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
AuthorizedKeysFile .ssh/authorized_keys
Subsystem sftp sftp-server.exe
'@
    Write-Cmd ('Out-File -Path "{0}"' -f $sshdConfigPath)
    $sshdConfig | Out-File -FilePath $sshdConfigPath -Encoding ASCII -Force
}

Invoke-LoggedStep '1.7' 'Restart sshd to apply configuration' {
    Write-Cmd 'Restart-Service sshd'
    Restart-Service sshd
    $finalSshService = Get-Service sshd -ErrorAction SilentlyContinue
    if (-not $finalSshService -or $finalSshService.Status -ne 'Running') {
        throw 'sshd is not running after restart'
    }
}

Invoke-LoggedStep '1.8' 'Open Windows Firewall for SSH (port 22)' {
    Set-OpenSshFirewallRule -Step '1.8'
}

Invoke-LoggedStep '1.9' 'Verify sshd is listening on port 22' {
    $listener = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) {
        throw 'No listener on port 22'
    }
    Write-Step '1.9' ('Listening on port 22 ({0})' -f $listener.LocalAddress)
}

Write-Log '=== INIT COMPLETE: SSH ready; install your own tools next ==='
