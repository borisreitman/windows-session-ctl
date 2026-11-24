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
- **Nothing to install by hand.** The first command copies the agent to the VM over SSH, registers it, and starts it. A
  newer version of the tool updates an older agent the same way.
- **It acts in the session you are looking at.** Whatever you see in your RDP window is what the tool sees and drives.

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
node cli/cli.mjs config host entelecheia-win11-test.eastus.cloudapp.azure.com
node cli/cli.mjs config key ~/.ssh/azure_test_vm
# user defaults to azureuser; set it with: config user <name>

# stay logged in over RDP; the first command bootstraps the agent:
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
   the VM user and SYSTEM only). The CLI reads it over SSH, caches it in `~/.config/windows-session-ctl/token` (mode
   0600), and sends it as the `X-Token` header. If the agent restarts, the 401 triggers a token refetch automatically.

### Automatic install and update

Before the first command in each CLI run, the CLI pings the agent. If the agent is unreachable, or reports a version
lower than the CLI's `AGENT_VERSION`, the CLI reinstalls it: stop the task, `scp` the script, create the task, start it,
wait for `agent.log` to say it is listening, fetch the token. The install is also available explicitly with `install`
(useful to force a restart). The agent never updates itself; replacement always goes through SSH, so a broken agent can
always be replaced.

When you change `agent/agent.ps1`, bump `$Version` there and `AGENT_VERSION` in `cli/cli.mjs` together.

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
| `config` | Print the stored config. |
| `config host\|user\|key\|port <value>` | Set the SSH target (stored in `~/.config/windows-session-ctl/config.json`). |
| `install` | Copy the agent to the VM, register the logon task, (re)start it. Normally implicit. |
| `up` / `down` | Open / close the SSH tunnel. Other commands open it on demand. |
| `status` | `{host, tunnel, agent, version, session, screen, user}`. Does **not** bootstrap the agent; it only reports. |
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
| `mouse move\|click\|dblclick\|rclick <x> <y>` | Move or click at a point. |
| `mouse drag <x1> <y1> <x2> <y2>` | Press at the first point, release at the second. |
| `mouse scroll <delta>` | Wheel at the current pointer position. `120` is one notch up, `-120` one notch down. |
| `type <text> [--window w]` | Send text to the focused window. With `--window`, that window is brought to the front first. Special characters (`+ ^ % ~ ( ) { } [ ]`) are escaped, so the text is typed literally. |
| `key <keys> [--window w]` | Send keys in [SendKeys syntax](https://learn.microsoft.com/dotnet/api/system.windows.forms.sendkeys): `^c` Ctrl+C, `%{F4}` Alt+F4, `{ENTER}`, `{TAB}`, `^{ESC}` Ctrl+Esc (opens Start), `{ESC}`. The Windows key cannot be sent. |

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

## Configuration

| Setting | Env var | Config key | Default |
|---|---|---|---|
| VM host | `WINSESSION_HOST` | `host` | none (required) |
| SSH user | `WINSESSION_USER` | `user` | `azureuser` |
| SSH key | `WINSESSION_KEY` | `key` | `~/.ssh/id_ed25519` |
| Local tunnel port | `WINSESSION_PORT` | `port` | `8766` |

Environment variables override the config file. The remote agent port is fixed at 8766. The tool targets one VM at a
time. To switch, give the second VM its own `WINSESSION_PORT` (a tunnel on the same local port belongs to the previous host),
or run `down` first.

## Security

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
| Agent keeps reinstalling | Version mismatch: bump `$Version` in `agent.ps1` and `AGENT_VERSION` in `cli/cli.mjs` together. |

Other known limits: the Windows key cannot be sent, `type` is limited to what SendKeys can type (very large text is slow,
so prefer `settext`), and only the session of the task's user is driven. UIA trees of some apps are huge, so use `find`
or a small `depth` instead of dumping everything.

## Layout

```
agent/agent.ps1          the in-session agent (UIA, SendInput, exec/psexec, screenshots, HTTP server)
cli/cli.mjs              the CLI (tunnel, auto-install, commands)
doc/windows-session-ctl   example global wrapper for ~/bin
```
