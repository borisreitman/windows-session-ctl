# windows-session-ctl

Drive the Windows desktop session you are already logged into (over RDP or at the console), from the shell: list windows, inspect the
controls inside them, click, type, run commands, take screenshots. It is the Windows-desktop counterpart of
[browser-session-ctl](../browser-session-ctl): a CLI that an AI coding agent (Claude Code, Cursor, …) or you can run to
operate a real, already-open session instead of starting a fresh, empty one.

```
you / agent --> CLI (Mac) --HTTP--> SSH tunnel --> agent.ps1 (inside your RDP session) --> UI Automation + SendInput
```

- **Structure first, pixels last.** `windows`, `tree`, `find`, `click`, `settext` and `gettext` use Windows UI Automation
  (UIA), the accessibility API. They address controls by name, so no coordinates and no screenshots are needed. Raw
  `mouse`, `type`, `key` and `screenshot` remain for apps that UIA cannot see (games, some custom-drawn UIs).
- **Explicit install, easy upgrade.** `install` puts the agent on the VM over SSH (a script, no software); `upgrade` replaces
  it later using the existing connection. Neither ever happens implicitly.
- **It acts in the session you are looking at.** Whatever you see in your RDP window is what the tool sees and drives.

There are two ways to connect, chosen per profile:

| | SSH profile (`--host`) | Azure profile (`--vm`) |
|---|---|---|
| Install / upgrade | `ssh` + `scp` | `az vm run-command` (no SSH, no open port needed to install) |
| Traffic | HTTP through an SSH tunnel to the agent's loopback port | HTTPS straight to the agent, **mutual TLS** |
| Authentication | SSH key, then a per-start token | client certificate |
| Network exposure | none beyond SSH | the agent port must be reachable from you (see below) |

## Requirements

| Where | What |
|---|---|
| Mac (or any Unix) | Node 18+, and `ssh` / `scp` on the PATH. No npm dependencies. |
| Windows VM | Windows 10/11 with PowerShell 5.1 (built in) and the OpenSSH server running. |
| Access | SSH to the VM with a private key (`BatchMode`, so no password prompts). |
| Session | Someone **logged in over RDP** (the agent needs an interactive desktop to live in). |

## Quick start

```bash
cd ~/work/windows-session-ctl
node cli/cli.mjs profile add win11 --host entelecheia-win11-test.eastus.cloudapp.azure.com --key ~/.ssh/azure_test_vm
# --user defaults to azureuser. With a single profile it is used automatically.

# stay logged in over RDP, then install the agent on the VM (one time):
node cli/cli.mjs install

# from now on:
node cli/cli.mjs windows
node cli/cli.mjs tree Notepad
node cli/cli.mjs settext Notepad "hello"
node cli/cli.mjs gettext Notepad
node cli/cli.mjs psexec 'Get-Date'
node cli/cli.mjs exec 'ver'
```

Optional global command (works from any directory, like `browser-session-ctl`):

```bash
cp doc/windows-session-ctl ~/bin/ && chmod +x ~/bin/windows-session-ctl   # edit DEFAULT_ROOT if you moved the repo
windows-session-ctl windows
```

## How it works

1. **The agent** (`agent/agent.ps1`) is one PowerShell script. It loads the .NET UI Automation and Windows Forms
   assemblies, then runs an HTTP server on `127.0.0.1:8766`. Each request is `POST /command` with a JSON body
   `{"method": "...", "params": {...}}` and a response of `{"ok": true, "result": ...}` or `{"ok": false, "error": "..."}`.
   It handles one request at a time.
2. **It must run inside your interactive session.** An SSH shell lives in session 0, which has no desktop, so it cannot
   see windows or send input. A scheduled task registered with `/IT` (interactive-only) starts the agent in the session
   of the logged-in user. The task is also set to run at every logon.
3. **The tunnel.** The CLI runs `ssh -N -L 8766:127.0.0.1:8766 <user>@<host>` in the background. Local port 8766 on your
   Mac then forwards, encrypted, to the agent on the VM. The agent only listens on the VM's loopback address and the NSG
   has no rule for 8766, so SSH is the only way in. The tunnel stays up between commands; `down` closes it.
4. **Auth.** The agent generates a random token at each start and writes it to `token` next to the script (file ACL:
   the VM user and SYSTEM only). The CLI reads it over SSH, caches it per profile in `~/.config/windows-session-ctl/tokens/<profile>.token` (mode
   0600), and sends it as the `X-Token` header. If the agent restarts, the 401 triggers a token refetch automatically.

### Install and upgrade (always explicit)

Nothing is installed or changed on the VM unless you run one of these:

| Command | When | What it does |
|---|---|---|
| `install` | First time on a machine, or when no agent answers | Stop any old task, `scp` the script, register the logon task, start it, wait for `agent.log` to say it is listening, fetch the token. Refuses if an agent already answers (use `upgrade`). |
| `upgrade [--force]` | An agent is running and the CLI has a newer one | Using the existing profile and connection, compare versions and, if the agent is older, replace it the same way. No-op when it is current; `--force` reinstalls anyway. Fails with a pointer to `install` if no agent answers. |

Every other command only **checks**: if no agent answers it stops with `The agent is not running on '<profile>'. Install it first: …`, and if the agent is older than the CLI it prints a `warning:` on stderr and carries on (a method added in a newer agent may then fail with `unknown method`; run `upgrade`). `status` shows `version`, `expectedVersion` and `upToDate`.

Install and upgrade both use SSH, and the agent never updates itself, so a broken agent can always be replaced. When you
change `agent/agent.ps1`, bump `$Version` there and `AGENT_VERSION` in `cli/cli.mjs` together.

### What lives on the VM

In `C:\Users\<user>\Downloads\windows-session-ctl\`:

| File | Purpose |
|---|---|
| `agent.ps1` | the agent |
| `token` | per-start auth token (restricted ACL) |
| `agent.log` | one line, written once the agent is listening |

plus a scheduled task named `windows-agent` (on logon, interactive, highest privileges). To remove everything:
`schtasks /Delete /TN windows-agent /F` and delete the folder.

## Command reference

Run `node cli/cli.mjs` with no arguments (or `help`) for the built-in usage text. Output is JSON unless noted.

### Setup and connection

| Command | What it does |
|---|---|
| `profile add <name> --host H [--user U] [--key K] [--port P]` | Save a target machine (stored in `~/.config/windows-session-ctl/config.json`). Re-running with the same name updates it. The local tunnel port is assigned automatically (8766, 8767, …) unless you pass `--port`. |
| `profile list` (alias `profiles`) / `profile rm <name>` | List profiles / remove one (closes its tunnel and deletes its cached token). |
| `--profile <name>` / `-p <name>` | Run any command against that profile. A unique name prefix is enough. Also `$WINSESSION_PROFILE`. |
| `install` | First install of the agent on the VM (see *Install and upgrade*). |
| `upgrade [--force]` | Replace the agent with this CLI's version, through the existing connection. |
| `up` / `down` | Open / close the SSH tunnel. Other commands open it on demand. |
| `status` | `{host, tunnel, agent, version, session, screen, user}`. Only reports; it never installs or changes anything. |
| `info` | Agent version, session id, user, host, screen size, cursor position. |

### Seeing what is on screen

| Command | What it does |
|---|---|
| `windows` | Visible top-level windows: type, name, class, process id, rectangle. |
| `tree <window> [depth]` | The control tree of a window (default depth 8, at most 800 nodes). Each node has `type`, `name`, optional `id` (AutomationId), `rect`, and `disabled`. |
| `find <window> <text>` | Flat list of controls whose name **or** AutomationId contains `text` (case-insensitive). |
| `gettext <window> [--control c]` | The text of a control (printed as plain text: Value pattern, else Text pattern, else its name). |
| `screenshot [path] [--window w]` | PNG of the whole virtual screen, or cropped to a window. Returns `{saved, w, h, x, y}`; `x`,`y` is the capture origin in screen coordinates. Default path `windows-screenshot.png`. |

### Acting on controls (no coordinates)

| Command | What it does |
|---|---|
| `focus <window>` | Restore and bring the window to the front. |
| `click <window> <name\|id>` | Activate a control. Tries Invoke, then Toggle, then Select, then Expand; if the control supports none of them, it clicks the centre of its rectangle (`via: click-center`). |
| `settext <window> <text> [--control c]` | Set an edit box or document. Uses the Value pattern; if the control is read-only or lacks it, it focuses the control, presses Ctrl+A and types the text. Without `--control` it targets the first Edit or Document control. |

### Running commands

| Command | What it does |
|---|---|
| `exec <cmd-command> [--timeout s]` | Run a **CMD** command or batch script **inside your session** and wait. Prints stdout, sends stderr to stderr, and exits with the command's exit code (124 if it timed out and was killed; default timeout 120 s). The command comes from the arguments, or from **stdin** when there are none (or `-`), so multi-line batch scripts and heredocs work. |
| `psexec <powershell> [--timeout s]` | The same, for **PowerShell**: arguments or stdin, stdout/stderr passthrough, exit code passthrough, `--timeout`. |
| `launch <exe> [args]` | Start a program in the session and return immediately (no output, no exit code). Use it for GUI apps. |
| `raw <method> [json]` | Call any agent method directly, e.g. `raw tree '{"window":"Notepad","depth":2}'`. |

Examples:

```bash
# install an MSIX/APPX package and get a real exit code and error text
windows-session-ctl psexec 'Add-AppxPackage -Path C:\Users\azureuser\Downloads\app.msix' --timeout 300
# install a debug package (sideload with a registered manifest)
windows-session-ctl psexec 'Add-AppxPackage -Register C:\build\AppxManifest.xml'
# see what is installed
windows-session-ctl psexec 'Get-AppxPackage *crosspass* | Select Name,Version'
# multi-line script from a pipe or heredoc (no quoting trouble)
windows-session-ctl psexec <<'EOF'
$p = Get-AppxPackage *crosspass*
if ($p) { Remove-AppxPackage $p }
Add-AppxPackage -Path C:\Users\azureuser\Downloads\app.msix
EOF
cat install.ps1 | windows-session-ctl psexec --timeout 600
# CMD: plain commands and batch scripts
windows-session-ctl exec 'dir C:\Users\azureuser\Downloads /b'
windows-session-ctl exec <<'EOF'
set X=hello
echo X is %X%
exit /b 4
EOF
# open the package with App Installer instead, then drive its window by name
windows-session-ctl launch C:\Users\azureuser\Downloads\app.msix
windows-session-ctl click "App Installer" Install
```

`psexec` runs a separate `powershell.exe` (`-NoProfile`, command sent as `-EncodedCommand`, so quotes and special characters
are safe); `exec` writes your text to a temporary `.cmd` file (so multi-line scripts work), runs it with `cmd.exe /d /c`
and deletes it. Both run as the VM user in the interactive session, elevated, so packages install for that user and apps
started from them appear on the desktop. Output is UTF-8 in both.

### Raw input (screen coordinates, same pixels as screenshots)

| Command | What it does |
|---|---|
| `mouse move <x> <y>` | Move the pointer to a point and remember it (with the current screen size). |
| `mouse click\|dblclick\|rclick [x y]` | Click at `x y`, or at the pointer when omitted. Without `x y` it is **refused with a `screen-changed:` error** if the screen resolution changed since the pointer was placed (see below). |
| `mouse drag <x1> <y1> <x2> <y2>` | Press at the first point, release at the second. |
| `mouse scroll <delta> [x y]` | Wheel at `x y`, or at the pointer when omitted (same guard). `120` is one notch up, `-120` one notch down. |
| `type <text> [--window w]` | Send text to the focused window. With `--window`, that window is brought to the front first. Special characters (`+ ^ % ~ ( ) { } [ ]`) are escaped, so the text is typed literally. |
| `key <keys> [--window w]` | Send keys in [SendKeys syntax](https://learn.microsoft.com/dotnet/api/system.windows.forms.sendkeys): `^c` Ctrl+C, `%{F4}` Alt+F4, `{ENTER}`, `{TAB}`, `^{ESC}` Ctrl+Esc (opens Start), `{ESC}`. The Windows key cannot be sent. |

### Resolution-change guard

When the RDP window is resized, the client rescales the picture and then changes the VM's resolution, which re-lays-out
every window. The pointer keeps its pixel position, so it can end up over something else. To stop a pointer-relative
action from landing on the wrong thing, the agent records the screen size and origin whenever the tool places the pointer
(`move`, `click x y`, `drag`, `scroll x y`). A later `click`, `dblclick`, `rclick` or `scroll` **without coordinates**
compares the current screen with that record and, if it changed, fails with:

```
error: screen-changed: the screen changed from 1498x917@0,0 to 1376x802@0,0 since the pointer was placed at (700,400), ...
```

Nothing is clicked. Re-check with `screenshot`, `tree` or `find`, then `mouse move` again. A click with no coordinates and
no recorded position is also an error. Commands that pass explicit coordinates are not guarded, since they place the
pointer themselves; name-based commands (`click <window> <name>`) never use coordinates. The record is held in the agent's
memory, so it is cleared when the agent restarts. It guards against resolution changes only, not against a window moving
or an app re-laying-out content at the same resolution.

### Matching rules

- **Windows** are matched by title: an exact match wins, otherwise the first window whose title contains the text. A
  window's title can change (an unsaved Notepad is `Untitled - Notepad`, then `*text - Notepad`), so use a short stable
  fragment such as `Notepad`.
- **Controls** are matched by exact Name or AutomationId first, then by Name substring. `*` means "first edit or
  document control".
- If nothing matches, the command exits non-zero with `error: no window matching '…'` / `no control matching '…'`.

## Recommended workflow

```
windows                              # what is open?
tree "My App" 4                      # what controls does it have? (names, ids, rectangles)
click "My App" "Save"                # act by name
gettext "My App" --control Status    # verify by reading, not by looking
screenshot --window "My App"         # only when you need to see it (visual check, custom-drawn UI)
```

Re-run `tree` or `find` after each action that changes the UI; names and rectangles move. If a control has no useful
name or `id` in `tree`, fall back to `mouse click` using the `rect` from `tree` (centre = `x + w/2`, `y + h/2`).

## Profiles

A profile is a named target machine: SSH host, user (default `azureuser`), key (default `~/.ssh/id_ed25519`), and its own
local tunnel port.

```bash
windows-session-ctl profile add win11 --host vm1.example.com --key ~/.ssh/vm1
windows-session-ctl profile add build --host vm2.example.com --user builder --key ~/.ssh/vm2
windows-session-ctl profile list
windows-session-ctl -p build windows
WINSESSION_PROFILE=win11 windows-session-ctl psexec 'Get-Date'
```

**Which profile is used** (first match wins):

1. `--profile` / `-p`, or `$WINSESSION_PROFILE`. A unique prefix of the name is accepted.
2. The only profile, if exactly one is configured. This is the "single session" case: no flag needed.
3. Otherwise the command fails and lists the profile names. The tool never guesses between several.

Each profile has its own SSH tunnel (local port), cached token, and agent on its machine, so two machines can be driven
at the same time from different terminals. `down` closes the tunnel of the selected profile only.

An older single-target config (`host`/`user`/`key` at the top level) is converted to a profile named `default`
automatically the first time the CLI runs.

**Ad hoc target.** Setting `WINSESSION_HOST` (with optional `WINSESSION_USER`, `WINSESSION_KEY`, `WINSESSION_PORT`)
bypasses profiles for that command, which is handy in scripts and CI.

One profile is one machine and one user. Driving two different users on the same VM is not supported: the agent uses a
fixed port and install folder per user, and the logon task runs for one user.

## Azure profiles (no SSH, mutual TLS)

```bash
az login                                            # subscription that holds the VM
windows-session-ctl profile add win11az --vm win11-test        # resource group, DNS name and user are discovered
windows-session-ctl -p win11az install                         # via az vm run-command; takes about a minute
windows-session-ctl -p win11az windows
windows-session-ctl -p win11az upgrade                         # later, also via run-command
```

Options for `profile add`: `--resource-group RG` (needed only if the VM name is ambiguous), `--user U` (desktop user,
default the VM's admin user), `--agent-port P` (default 8443), `--connect host:port` (see *Reachability*).

Needs: Azure CLI logged in with permission to run commands on the VM, `openssl` locally, a **running** Windows VM whose
public IP has a DNS name, and someone logged in on its desktop.

### What `install` does

1. Looks up the VM by name (resource group, DNS name, admin user, power state).
2. Creates a local CA and client certificate on first use (`~/.config/windows-session-ctl/pki/`).
3. On the VM, creates the server key (machine store, non-exportable) and returns a signing request.
4. Signs it locally for the VM's DNS name.
5. On the VM: stores the certificate and links it to the key, binds it to the port with client-certificate negotiation,
   adds a **Windows Firewall** rule for the port, writes `agent.ps1`, `ca.crt` and `tls.port`, and registers and starts
   the logon task.

Only public material travels through run-command. The server key never leaves the VM; the CA and client keys never leave
your machine. The CA is **not** added to the VM's trusted roots: the agent itself accepts only client certificates that
chain to the `ca.crt` in its folder and carry the client-authentication usage. The CLI trusts only that CA for the server
and checks the DNS name.

### Reachability

**The tool never creates or changes an Azure Network Security Group.** After install, your machine must be able to reach
`<dns-name>:<agent-port>` by a route you provide: an NSG rule you manage (for example in Terraform), a VPN or mesh
network, or a tunnel. If it cannot, `install` says so and the agent is still installed. To go through a tunnel or private
address, use `--connect host:port`; the certificate is still verified against the DNS name:

```bash
ssh -N -L 18443:127.0.0.1:8443 azureuser@<vm> &       # example tunnel, if you have SSH after all
windows-session-ctl profile add win11az --vm win11-test --connect 127.0.0.1:18443
```

`upgrade` needs a working connection (it checks the running version first); `install` does not.

### Certificates

| File (in `~/.config/windows-session-ctl/pki/`) | Lifetime | Notes |
|---|---|---|
| `ca.crt` / `ca.key` | 10 years | signs everything; keep `ca.key` private. Anyone holding it can control your VMs' agents. |
| `client.crt` / `client.key` | 825 days | your identity to every Azure-profile agent. Delete both and run `install` to renew. |
| server certificate (on the VM) | 730 days | renew by running `install` again (stop the agent's task first, or it reports "already installed"). |

There is no revocation: to cut off a lost client key, delete the whole `pki/` folder and reinstall each VM. Another
computer needs its own copy of `pki/` (or its own CA and a reinstall, which replaces the trusted CA on that VM).

### Removing it from a VM

`profile rm` only forgets the profile locally. On the VM (elevated): `schtasks /Delete /TN windows-agent /F`,
`netsh http delete sslcert ipport=0.0.0.0:8443`, `netsh http delete urlacl url=https://+:8443/`,
`netsh advfirewall firewall delete rule name="windows-session-ctl agent"`, delete the certificate issued by
`windows-session-ctl CA` from `Cert:\LocalMachine\My`, and delete the folder under Downloads.

## Security

- Azure profiles expose the agent on the network (as far as your NSG and firewall allow). Client-certificate
  authentication is then the only gate, so limit who can reach the port and protect `pki/`.

- The agent can read and click anything in the session, and run commands, with the privileges of the VM user (the task
  runs elevated). Treat access to it like access to the logged-in desktop.
- It binds to `127.0.0.1` only, requires a token, and is reached only through SSH. Do not open port 8766 in a firewall.
- UIA can read the text of any control, including fields you may not want in your terminal or logs (password fields are
  masked by Windows, but other secrets on screen are not).
- The token file is restricted to the VM user and SYSTEM; the cached copy on the Mac is mode 0600.

## Limits and troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Agent did not start. Is anyone logged in over RDP…` | No interactive session exists. Connect over RDP, then retry. |
| Screenshots black or frozen, controls missing | The RDP session was **disconnected** (not signed out) and the desktop is locked. Reconnect. |
| `Could not open the SSH tunnel` | Port 8766 is taken locally, or SSH to the VM failed. Test with `ssh -i <key> <user>@<host>`; `down` clears a stale tunnel. |
| `no window matching …` | The title changed or the window is minimised/off-screen. Check `windows`. |
| Text typed into the wrong place | `type` and `key` go to whichever window has focus. Use `--window`, or `settext` / `click`. |
| An app does not respond to `click` | It may expose no UIA patterns; use `mouse click` at the centre of its `rect`. |
| A long `exec` / `psexec` blocks other commands | The agent handles one request at a time; raise `--timeout`, or use `launch` for long-running programs. |
| `warning: the agent … is version N, this CLI expects M` | The VM has an older agent. Run `upgrade`. If it persists after upgrading, `$Version` in `agent.ps1` and `AGENT_VERSION` in `cli/cli.mjs` are out of step. |
| `The agent is not running on '…'` | No agent answers. Run `install` (someone must be logged in on the VM). |

Other known limits: the Windows key cannot be sent, `type` is limited to what SendKeys can type (very large text is slow,
so prefer `settext`), and only the session of the task's user is driven. UIA trees of some apps are huge, so use `find`
or a small `depth` instead of dumping everything.

## Layout

```
agent/agent.ps1          the in-session agent (UIA, SendInput, exec/psexec, screenshots, HTTP + mTLS server)
cli/cli.mjs              the CLI (profiles, tunnel, install/upgrade, commands)
cli/azure.mjs            find a VM and run PowerShell on it with `az vm run-command`
cli/vm-scripts.mjs       the PowerShell that Azure install / upgrade runs on the VM
cli/pki.mjs              local CA, client certificate, server certificate signing
doc/windows-session-ctl   example global wrapper for ~/bin
```
