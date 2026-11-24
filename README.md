# winrdp-session-ctl

Drive the Windows desktop session you are already logged into over RDP, from the shell. Same idea as
[browser-session-ctl](../browser-session-ctl), but for a Windows VM instead of Chrome.

```
you / agent --> CLI (Mac) --HTTP--> ssh tunnel --> agent.ps1 (inside the RDP session) --> UI Automation + SendInput
```

The agent has to run **inside the interactive session**: an SSH shell lives in session 0, which has no desktop. A scheduled
task registered with `/IT` starts it in the session of the logged-in user. It listens on `127.0.0.1:8766` only, requires a
token (stored in `C:\uiauto\token`, ACL'd to the user), and is reached through an SSH tunnel the CLI opens on demand.

Prefer **structure over pixels**: `windows`, `tree`, `find`, `click <window> <name>`, `settext`, `gettext` use Windows UI
Automation (no coordinates, no screenshots). Use `mouse`, `type`, `key`, `screenshot` for apps UIA cannot see.

## Setup
```bash
node cli/cli.mjs config host <vm-dns-name>      # also: user (default azureuser), key (ssh private key)
# be logged in over RDP, then:
node cli/cli.mjs install                        # copies agent.ps1, registers the logon task, starts it
node cli/cli.mjs status
```
Optional global command: `cp doc/winrdp-session-ctl ~/bin/` (edit `DEFAULT_ROOT` if the clone lives elsewhere).

## Commands
`windows`, `tree <window> [depth]`, `find <window> <text>`, `focus`, `click <window> <name|id>`,
`settext <window> <text> [--control c]`, `gettext <window> [--control c]`, `type`, `key` (SendKeys syntax),
`mouse move|click|dblclick|rclick|drag|scroll`, `screenshot [path] [--window w]`, `launch`, `raw`. Run with no args for usage.

## Limits
- If you **disconnect** the RDP session (rather than stay connected), Windows locks the desktop and capture / UIA stop working.
- Elevated (admin) windows can't be driven by a non-elevated agent; the task runs with highest privileges to avoid this.
- Fixed to one VM at a time (`config host`). The agent restarts at each logon, so token changes are handled automatically.
