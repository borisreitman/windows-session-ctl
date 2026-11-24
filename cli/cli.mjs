#!/usr/bin/env node
// winrdp-session-ctl: drive the Windows desktop session you are logged into over RDP.
//   Mac CLI --HTTP--> ssh tunnel (127.0.0.1:LOCAL) --> agent.ps1 inside the RDP session --> UI Automation / SendInput
import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG_DIR = join(homedir(), ".config", "winrdp-session-ctl");
const CFG_FILE = join(CFG_DIR, "config.json");
const TOKEN_FILE = join(CFG_DIR, "token");
const AGENT_PORT = 8766;
const rdir = (t) => `C:\\Users\\${t.user}\\Downloads\\winrdp-session-ctl`; // install dir on the VM
const AGENT_VERSION = 2; // keep in step with $Version in agent/agent.ps1

const USAGE = `Drive the Windows desktop session you are logged into over RDP.

  winrdp-session-ctl config [host|user|key|port <value>]   show / set the target VM
  winrdp-session-ctl install            copy the agent to the VM, register it to start at logon, start it
  winrdp-session-ctl up | down          open / close the SSH tunnel (other commands open it on demand)
  winrdp-session-ctl status             tunnel, agent, session, screen size

  winrdp-session-ctl windows                       visible top-level windows (name, class, pid, rect)
  winrdp-session-ctl tree <window> [depth]         controls inside a window (UI Automation tree, JSON)
  winrdp-session-ctl find <window> <text>          controls whose name / automation id contains text
  winrdp-session-ctl focus <window>
  winrdp-session-ctl click <window> <name|id>      Invoke/Toggle/Select by name, no coordinates needed
  winrdp-session-ctl settext <window> <text> [--control <name|id>]   set an edit box / document (default: first one)
  winrdp-session-ctl gettext <window> [--control <name|id>]
  winrdp-session-ctl type <text> [--window <w>]    keystrokes to the focused window
  winrdp-session-ctl key <keys> [--window <w>]     SendKeys syntax: ^c  %{F4}  {ENTER}  ^{ESC}
  winrdp-session-ctl mouse <move|click|dblclick|rclick> <x> <y>
  winrdp-session-ctl mouse drag <x1> <y1> <x2> <y2>
  winrdp-session-ctl mouse scroll <delta>          120 = one notch up, -120 = down
  winrdp-session-ctl screenshot [path] [--window <w>]
  winrdp-session-ctl launch <exe> [args]
  winrdp-session-ctl raw <method> [json-params]

Window names match exactly first, then by substring. Coordinates are screen pixels as in screenshots.
Target: WINRDP_HOST / WINRDP_USER / WINRDP_KEY env vars, or \`config\`. Prefer \`tree\`/\`find\`/\`click\` over screenshots.`;

const die = (m) => { console.error(m); process.exit(1); };
const loadCfg = () => (existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, "utf8")) : {});
function target() {
  const c = loadCfg();
  const t = {
    host: process.env.WINRDP_HOST || c.host,
    user: process.env.WINRDP_USER || c.user || "azureuser",
    key: process.env.WINRDP_KEY || c.key || join(homedir(), ".ssh", "id_ed25519"),
    port: Number(process.env.WINRDP_PORT || c.port || AGENT_PORT),
  };
  if (!t.host) die("No host. Run: winrdp-session-ctl config host <dns-name-or-ip>");
  return t;
}
const sshBase = (t) => ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-i", t.key];
function ssh(t, remote) {
  const r = spawnSync("ssh", [...sshBase(t), `${t.user}@${t.host}`, remote], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

async function call(t, method, params = {}, tok) {
  const res = await fetch(`http://127.0.0.1:${t.port}/command`, {
    method: "POST", headers: { "X-Token": tok, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function alive(t) { return new Promise((res) => { const s = net.connect(t.port, "127.0.0.1"); s.setTimeout(1500); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); }); }
async function up(t) {
  if (await alive(t)) return;
  const p = spawn("ssh", [...sshBase(t), "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
    "-L", `${t.port}:127.0.0.1:${AGENT_PORT}`, `${t.user}@${t.host}`], { detached: true, stdio: "ignore" });
  p.unref();
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 300)); if (await alive(t)) return; }
  die("Could not open the SSH tunnel.");
}
function fetchToken(t) {
  const r = ssh(t, `type "${rdir(t)}\\token"`);
  if (r.code !== 0 || !r.out) die("Agent token not found; run: winrdp-session-ctl install  (and be logged in over RDP)");
  mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(TOKEN_FILE, r.out, { mode: 0o600 }); return r.out;
}

async function installAgent(t) {
  console.error("Installing agent on the VM...");
  ssh(t, `if not exist "${rdir(t)}" mkdir "${rdir(t)}"`);
  ssh(t, "schtasks /End /TN winrdp-agent");
  const sc = spawnSync("scp", ["-q", "-i", t.key, join(ROOT, "agent", "agent.ps1"), `${t.user}@${t.host}:${rdir(t).replace(/\\/g, "/")}/agent.ps1`], { encoding: "utf8" });
  if (sc.status !== 0) die("scp failed: " + sc.stderr);
  const mk = ssh(t, `schtasks /Create /TN winrdp-agent /F /SC ONLOGON /RU ${t.user} /IT /RL HIGHEST /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \\"${rdir(t)}\\agent.ps1\\""`);
  if (mk.code !== 0) die("schtasks create failed: " + (mk.out || mk.err));
  ssh(t, `del "${rdir(t)}\\agent.log"`);
  const run = ssh(t, "schtasks /Run /TN winrdp-agent");
  if (run.code !== 0) die("schtasks run failed: " + (run.out || run.err));
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const l = ssh(t, `type "${rdir(t)}\\agent.log"`);
    if (l.out.includes("listening")) { fetchToken(t); console.error(l.out); return; }
  }
  die("Agent did not start. Is anyone logged in over RDP on the VM?");
}
let checked = false;
async function tryCall(t, method, params) {
  let tok = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, "utf8") : "";
  let r = tok ? await call(t, method, params, tok).catch(() => null) : null;
  if (!r || r.status === 401) { // stale token or agent restarted: re-read it from the VM
    const f = ssh(t, `type "${rdir(t)}\\token"`);
    if (f.code === 0 && f.out) { mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(TOKEN_FILE, f.out, { mode: 0o600 }); r = await call(t, method, params, f.out).catch(() => null); }
  }
  return r;
}
async function rpc(method, params = {}) {
  const t = target(); await up(t);
  if (!checked) { // bootstrap or update on demand: missing, unreachable or older agent -> copy it over SSH
    checked = true;
    const p = await tryCall(t, "ping", {});
    if (!p || !p.body.ok || (p.body.result.version || 0) < AGENT_VERSION) await installAgent(t);
  }
  const r = await tryCall(t, method, params);
  if (!r) die("Agent not answering. Is an RDP session logged in on the VM?");
  if (!r.body.ok) die(`error: ${r.body.error}`);
  return r.body.result;
}
const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

// ---- args ----
const argv = process.argv.slice(2);
const flags = {}; const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--window" || argv[i] === "--control") flags[argv[i].slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const [cmd, ...a] = pos;
if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); process.exit(cmd ? 0 : 1); }

switch (cmd) {
  case "config": {
    const c = loadCfg();
    if (a.length === 2) { c[a[0]] = a[1]; mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(CFG_FILE, JSON.stringify(c, null, 2)); }
    print(c); break;
  }
  case "install": { await installAgent(target()); break; }
  case "up": await up(target()); console.log("tunnel up"); break;
  case "down": spawnSync("pkill", ["-f", `127.0.0.1:${AGENT_PORT}.*${target().host}`]); console.log("tunnel down"); break;
  case "status": { const t = target(); const tun = await alive(t); let info = null; if (tun) info = await rpc("info").catch(() => null); print({ host: t.host, tunnel: tun, agent: !!info, ...(info || {}) }); break; }
  case "info": print(await rpc("info")); break;
  case "windows": print(await rpc("windows")); break;
  case "tree": print(await rpc("tree", { window: a[0], depth: a[1] })); break;
  case "find": print(await rpc("find", { window: a[0], query: a[1] })); break;
  case "focus": print(await rpc("focus", { window: a[0] })); break;
  case "click": print(await rpc("invoke", { window: a[0], name: a[1] })); break;
  case "settext": print(await rpc("settext", { window: a[0], text: a.slice(1).join(" "), name: flags.control })); break;
  case "gettext": { const r = await rpc("gettext", { window: a[0], name: flags.control }); console.log(r.text); break; }
  case "type": print(await rpc("type", { text: a.join(" "), window: flags.window })); break;
  case "key": print(await rpc("key", { keys: a[0], window: flags.window })); break;
  case "mouse": {
    const [action, ...n] = a; const v = n.map(Number);
    print(await rpc("mouse", action === "scroll" ? { action, delta: v[0] } : { action, x: v[0], y: v[1], x2: v[2], y2: v[3] })); break;
  }
  case "launch": print(await rpc("launch", { path: a[0], args: a.slice(1).join(" ") })); break;
  case "screenshot": {
    const out = a[0] || "winrdp-screenshot.png"; const r = await rpc("screenshot", { window: flags.window });
    writeFileSync(out, Buffer.from(r.png, "base64")); print({ saved: out, w: r.w, h: r.h, x: r.x, y: r.y }); break;
  }
  case "raw": print(await rpc(a[0], a[1] ? JSON.parse(a[1]) : {})); break;
  default: console.error(`Unknown command: ${cmd}\n`); console.log(USAGE); process.exit(1);
}
