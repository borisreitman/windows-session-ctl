#!/usr/bin/env node
// windows-session-ctl: drive the Windows desktop session a user is logged into (RDP or console), over SSH.
//   ssh profile:   CLI --HTTP+token--> ssh tunnel (127.0.0.1:LOCAL) --> agent.ps1 in the desktop session
//   azure profile: CLI --HTTPS, mutual TLS--> agent.ps1   (installed through `az vm run-command`, no SSH)
import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import https from "node:https";
import { ensurePki, signServerCsr, caPem, CA_CRT, CLIENT_CRT, CLIENT_KEY } from "./pki.mjs";
import { findVm, runPowerShell } from "./azure.mjs";
import { csrScript, installScript, upgradeScript } from "./vm-scripts.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG_DIR = join(homedir(), ".config", "windows-session-ctl");
const CFG_FILE = join(CFG_DIR, "config.json");
const TOKEN_DIR = join(CFG_DIR, "tokens");
const AGENT_PORT = 8766;
const DEFAULT_TLS_PORT = 8443;
const rdir = (t) => `C:\\Users\\${t.user}\\Downloads\\windows-session-ctl`; // install dir on the VM
const AGENT_VERSION = 8; // keep in step with $Version in agent/agent.ps1

const USAGE = `Drive the Windows desktop session a user is logged into (RDP or console), over SSH.

  windows-session-ctl profile add <name> --host H [--user U] [--key K] [--port P]   save a target machine
  windows-session-ctl profile add <name> --vm <azure-vm> [--resource-group RG] [--agent-port P] [--connect host:port]   Azure VM, direct mTLS (no SSH)
  windows-session-ctl profile list | rm <name>      (alias: profiles)
  windows-session-ctl --profile <name> <command>    pick a profile (-p, or $WINSESSION_PROFILE); optional when only one exists
  windows-session-ctl install            (Azure profiles: via az run-command + mutual TLS) first install of the agent on the VM (copy, register logon task, start); never automatic
  windows-session-ctl upgrade [--force]  replace the agent of a working connection with this CLI's version (no-op if current)
  windows-session-ctl up | down          open / close the SSH tunnel (other commands open it on demand)
  windows-session-ctl status             tunnel, agent, session, screen size

  windows-session-ctl windows                       visible top-level windows (name, class, pid, rect)
  windows-session-ctl tree <window> [depth]         controls inside a window (UI Automation tree, JSON)
  windows-session-ctl find <window> <text>          controls whose name / automation id contains text
  windows-session-ctl focus <window>
  windows-session-ctl click <window> <name|id>      Invoke/Toggle/Select by name, no coordinates needed
  windows-session-ctl settext <window> <text> [--control <name|id>]   set an edit box / document (default: first one)
  windows-session-ctl gettext <window> [--control <name|id>]
  windows-session-ctl type <text> [--window <w>]    keystrokes to the focused window
  windows-session-ctl key <keys> [--window <w>]     SendKeys syntax: ^c  %{F4}  {ENTER}  ^{ESC}
  windows-session-ctl mouse move <x> <y>
  windows-session-ctl mouse <click|dblclick|rclick> [x y]   without x y: at the pointer; refused if the screen resolution changed since it was placed
  windows-session-ctl mouse drag <x1> <y1> <x2> <y2>
  windows-session-ctl mouse scroll <delta> [x y]    120 = one notch up, -120 = down; same resolution guard without x y
  windows-session-ctl screenshot [path] [--window <w>]
  windows-session-ctl launch <exe> [args]           start a program in the session, do not wait
  windows-session-ctl exec <cmd-command> [--timeout s]  run a CMD command/batch script in the session (arg, or stdin when piped), wait, print stdout; exit code passed through
  windows-session-ctl psexec <powershell> [--timeout s]  same, for PowerShell
  windows-session-ctl raw <method> [json-params]

Window names match exactly first, then by substring. Coordinates are screen pixels as in screenshots.
Profile: --profile/-p, $WINSESSION_PROFILE, or the only profile if there is just one; with several and none chosen the command fails and lists them.
Ad hoc: WINSESSION_HOST (+ _USER, _KEY, _PORT) bypasses profiles. Prefer \`tree\`/\`find\`/\`click\` over screenshots.`;

const die = (m) => { console.error(m); process.exit(1); };
process.on("uncaughtException", (e) => die(`error: ${e.message}`));
const DEFAULT_USER = "azureuser", DEFAULT_KEY = join(homedir(), ".ssh", "id_ed25519");
function loadCfg() {
  let c = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, "utf8")) : {};
  if (c.host && !c.profiles) { // legacy single-target config -> a profile named "default"
    const { host, user, key, port } = c;
    c = { profiles: { default: { host, user, key, port: port || AGENT_PORT } } };
    saveCfg(c);
  }
  c.profiles ||= {};
  return c;
}
function saveCfg(c) { mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(CFG_FILE, JSON.stringify(c, null, 2) + "\n"); }
function makeTarget(name, p) {
  if (p.vm) return { name, transport: "azure", vm: p.vm, rg: p.resourceGroup, user: p.user, fqdn: p.fqdn, agentPort: Number(p.agentPort || DEFAULT_TLS_PORT), connect: p.connect };
  return { transport: "ssh", name, host: p.host, user: p.user || DEFAULT_USER, key: p.key || DEFAULT_KEY, port: Number(p.port || AGENT_PORT) };
}
function target() {
  if (process.env.WINSESSION_HOST) { // ad hoc target, no profile
    return makeTarget(`env-${process.env.WINSESSION_HOST}`, { host: process.env.WINSESSION_HOST, user: process.env.WINSESSION_USER,
      key: process.env.WINSESSION_KEY, port: process.env.WINSESSION_PORT });
  }
  const names = Object.keys(loadCfg().profiles), profiles = loadCfg().profiles;
  const want = flags.profile || process.env.WINSESSION_PROFILE;
  if (want) {
    const hit = names.includes(want) ? [want] : names.filter((n) => n.startsWith(want));
    if (hit.length === 1) return makeTarget(hit[0], profiles[hit[0]]);
    die(hit.length ? `Profile '${want}' is ambiguous: ${hit.join(", ")}` : `No profile '${want}'. Profiles: ${names.join(", ") || "(none)"}`);
  }
  if (names.length === 1) return makeTarget(names[0], profiles[names[0]]); // the single profile is used automatically
  if (!names.length) die("No profiles. Add one: windows-session-ctl profile add <name> --host <dns-name-or-ip> [--user U] [--key K]");
  die(`Several profiles; choose one with --profile <name> (or $WINSESSION_PROFILE): ${names.join(", ")}`);
}
const tokenFile = (t) => join(TOKEN_DIR, t.name.replace(/[^\w.-]/g, "_") + ".token");
function storeToken(t, tok) { mkdirSync(TOKEN_DIR, { recursive: true }); writeFileSync(tokenFile(t), tok, { mode: 0o600 }); }
const sshBase = (t) => ["-q", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-i", t.key];
function ssh(t, remote) {
  const r = spawnSync("ssh", [...sshBase(t), `${t.user}@${t.host}`, remote], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

function httpsCall(t, method, params) { // mutual TLS: we present our client cert and trust only our CA, for the VM's DNS name
  return new Promise((resolve, reject) => {
    if (!t.fqdn) return reject(new Error("no DNS name known; run install"));
    const [h, pt] = t.connect ? t.connect.split(":") : [t.fqdn, t.agentPort];
    const body = JSON.stringify({ method, params });
    const req = https.request({ agent: false, host: h, port: Number(pt), servername: t.fqdn, path: "/command", method: "POST", // agent:false: a pooled socket would be dead after an agent restart
      ca: readFileSync(CA_CRT), cert: readFileSync(CLIENT_CRT), key: readFileSync(CLIENT_KEY), minVersion: "TLSv1.2",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } }, (res) => {
      const ch = []; res.on("data", (d) => ch.push(d));
      res.on("end", () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(ch).toString("utf8")) }); } catch (e) { reject(e); } });
    });
    req.setTimeout(method === "ping" ? 10000 : 900000, () => req.destroy(new Error("timeout")));
    req.on("error", reject); req.end(body);
  });
}
async function call(t, method, params = {}, tok) {
  if (t.transport === "azure") return httpsCall(t, method, params);
  const res = await fetch(`http://127.0.0.1:${t.port}/command`, {
    method: "POST", headers: { "X-Token": tok, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function alive(t) { return new Promise((res) => { const s = net.connect(t.port, "127.0.0.1"); s.setTimeout(1500); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); }); }
async function up(t) {
  if (t.transport === "azure") return; // direct connection, no tunnel
  if (await alive(t)) return;
  const p = spawn("ssh", [...sshBase(t), "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
    "-L", `${t.port}:127.0.0.1:${AGENT_PORT}`, `${t.user}@${t.host}`], { detached: true, stdio: "ignore" });
  p.unref();
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 300)); if (await alive(t)) return; }
  die("Could not open the SSH tunnel.");
}
function fetchToken(t) {
  const r = ssh(t, `type "${rdir(t)}\\token"`);
  if (r.code !== 0 || !r.out) die("Agent token not found; run: windows-session-ctl install  (and be logged in over RDP)");
  storeToken(t, r.out); return r.out;
}

async function installAgent(t) {
  console.error("Installing agent on the VM...");
  ssh(t, `if not exist "${rdir(t)}" mkdir "${rdir(t)}"`);
  ssh(t, "schtasks /End /TN windows-agent");
  const sc = spawnSync("scp", ["-q", "-i", t.key, join(ROOT, "agent", "agent.ps1"), `${t.user}@${t.host}:${rdir(t).replace(/\\/g, "/")}/agent.ps1`], { encoding: "utf8" });
  if (sc.status !== 0) die("scp failed: " + sc.stderr);
  const mk = ssh(t, `schtasks /Create /TN windows-agent /F /SC ONLOGON /RU ${t.user} /IT /RL HIGHEST /TR "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \\"${rdir(t)}\\agent.ps1\\""`);
  if (mk.code !== 0) die("schtasks create failed: " + (mk.out || mk.err));
  ssh(t, `del "${rdir(t)}\\agent.log"`);
  const run = ssh(t, "schtasks /Run /TN windows-agent");
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
  if (t.transport === "azure") return call(t, method, params).catch(() => null);
  let tok = existsSync(tokenFile(t)) ? readFileSync(tokenFile(t), "utf8") : "";
  let r = tok ? await call(t, method, params, tok).catch(() => null) : null;
  if (!r || r.status === 401) { // stale token or agent restarted: re-read it from the VM
    const f = ssh(t, `type "${rdir(t)}\\token"`);
    if (f.code === 0 && f.out) { storeToken(t, f.out); r = await call(t, method, params, f.out).catch(() => null); }
  }
  return r;
}
async function azureSetup(t, upgrade) {
  const vm = findVm(t.vm, t.rg);
  if (vm.os && vm.os !== "Windows") die(`'${vm.name}' is not a Windows VM`);
  if (!/running/i.test(vm.power || "")) die(`VM '${vm.name}' is '${vm.power}'. Start it first (run-command needs a running VM).`);
  if (!vm.fqdn) die(`The public IP of '${vm.name}' has no DNS name. Give it a DNS label in Azure; the certificate and TLS verification use the name.`);
  const user = t.user || vm.user;
  console.error(`Azure VM ${vm.name} (resource group ${vm.rg}) -> ${vm.fqdn}, desktop user ${user}`);
  const agentB64 = Buffer.from(readFileSync(join(ROOT, "agent", "agent.ps1"))).toString("base64");
  const run = (script) => { const r = runPowerShell(vm.rg, vm.name, script); return r; };
  let out;
  if (upgrade) {
    console.error("Replacing the agent on the VM through Azure run-command...");
    out = run(upgradeScript({ user, port: t.agentPort, agentB64 }));
  } else {
    ensurePki();
    console.error("1/3 Creating the agent's server key on the VM (it never leaves the VM)...");
    const a = run(csrScript(vm.fqdn));
    const csr = (a.stdout.match(/CSR-BEGIN\s*([\s\S]*?)\s*CSR-END/) || [])[1];
    if (!csr) die("The VM did not return a certificate request:\n" + [a.stdout, a.stderr].filter(Boolean).join("\n"));
    console.error("2/3 Signing the certificate with the local CA...");
    const certB64 = Buffer.from(signServerCsr(csr + "\n", vm.fqdn)).toString("base64");
    console.error("3/3 Installing certificate, agent, firewall rule and logon task on the VM...");
    out = run(installScript({ user, port: t.agentPort, agentB64, caB64: Buffer.from(caPem()).toString("base64"), certB64 }));
  }
  if (!/AGENT-LOG:/.test(out.stdout)) die("Install on the VM failed:\n" + ([out.stdout, out.stderr].filter(Boolean).join("\n") || "(no output from run-command)"));
  console.error(out.stdout.match(/AGENT-LOG:.*/)[0]);
  const c = loadCfg(); const prev = c.profiles[t.name] || {};
  c.profiles[t.name] = { ...prev, vm: vm.name, resourceGroup: vm.rg, user, fqdn: vm.fqdn, agentPort: t.agentPort };
  saveCfg(c);
  return makeTarget(t.name, c.profiles[t.name]);
}
async function agentVersion(t) { // null when no agent answers
  await up(t); const p = await tryCall(t, "ping", {});
  return p && p.body.ok ? p.body.result.version || 0 : null;
}
const me = (t) => `windows-session-ctl${t.name.startsWith("env-") ? "" : ` -p ${t.name}`}`;
async function rpc(method, params = {}) {
  const t = target(); await up(t);
  if (!checked) { // never installs or updates by itself: only reports, and points at `install`
    checked = true;
    const p = await tryCall(t, "ping", {});
    if ((!p || !p.body.ok) && t.transport === "azure") die(`No agent answers on ${t.connect || `${t.fqdn || t.vm}:${t.agentPort}`} (mutual TLS). If it is installed, the port is probably not reachable from here: the tool never changes the NSG, so open TCP ${t.agentPort} to your address yourself or use --connect via a tunnel/VPN. Not installed yet: ${me(t)} install`);
    if (!p || !p.body.ok) die(`The agent is not running on '${t.name}'. Install it first: ${me(t)} install  (needs someone logged in on the VM)`);
    const v = p.body.result.version || 0;
    if (v < AGENT_VERSION) console.error(`warning: the agent on '${t.name}' is version ${v}, this CLI expects ${AGENT_VERSION}. Update it with: ${me(t)} upgrade`);
  }
  const r = await tryCall(t, method, params);
  if (!r) die("Agent not answering. Is a desktop session logged in on the VM?");
  if (!r.body.ok) die(`error: ${r.body.error}`);
  return r.body.result;
}
async function runShell(shell) {
  let command = a.join(" ");
  if (a.length === 0 || command === "-") { // no argument (or "-"): read the script from stdin
    if (process.stdin.isTTY) die(`${cmd}: give a command, or pipe one in (echo 'dir' | windows-session-ctl ${cmd})`);
    command = readFileSync(0, "utf8");
  }
  if (!command.trim()) die(`${cmd}: empty command`);
  const r = await rpc("exec", { command, shell, timeout: flags.timeout });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.timedOut) console.error(`${cmd}: timed out (process killed)`);
  process.exit(r.timedOut ? 124 : r.exitCode);
}
const print = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

// ---- args ----
const argv = process.argv.slice(2);
const flags = {}; const pos = [];
const VALUE_FLAGS = ["--window", "--control", "--timeout", "--profile"], PROFILE_FLAGS = ["--host", "--user", "--key", "--port", "--vm", "--resource-group", "--agent-port", "--connect"];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--force") { flags.force = true; continue; }
  const f = argv[i] === "-p" ? "--profile" : argv[i];
  if (VALUE_FLAGS.includes(f) || (pos[0] === "profile" && PROFILE_FLAGS.includes(f))) flags[f.slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const [cmd, ...a] = pos;
if (!cmd || cmd === "help" || cmd === "--help") { console.log(USAGE); process.exit(cmd ? 0 : 1); }

switch (cmd) {
  case "profile": case "profiles": {
    const c = loadCfg(); const sub = cmd === "profiles" ? "list" : a[0] || "list"; const name = a[1];
    if (sub === "add") {
      if (flags.vm) { // Azure VM, direct mTLS: no SSH, no local tunnel port
        if (!name) die("usage: profile add <name> --vm <azure-vm-name> [--resource-group RG] [--agent-port P] [--connect host:port]");
        if (!/^[\w.-]+$/.test(flags.vm)) die("odd VM name");
        const keep = c.profiles[name]?.vm === flags.vm ? c.profiles[name] : {};
        c.profiles[name] = { ...keep, vm: flags.vm, ...(flags["resource-group"] && { resourceGroup: flags["resource-group"] }), ...(flags.user && { user: flags.user }),
          agentPort: Number(flags["agent-port"] || keep.agentPort || DEFAULT_TLS_PORT), ...(flags.connect && { connect: flags.connect }) };
        if (!flags.connect) delete c.profiles[name].connect;
        saveCfg(c);
      } else {
      if (!name || !flags.host) die("usage: profile add <name> --host H [--user U] [--key K] [--port P]  |  profile add <name> --vm <azure-vm>");
      if (!/^[\w.-]+$/.test(name)) die("profile names may use letters, digits, . _ - only");
      const used = new Set(Object.entries(c.profiles).filter(([n, p]) => n !== name && !p.vm).map(([, p]) => Number(p.port)));
      let port = Number(flags.port || c.profiles[name]?.port || 0);
      if (!port) { port = AGENT_PORT; while (used.has(port)) port++; }
      if (used.has(port)) die(`local port ${port} is used by another profile`);
      c.profiles[name] = { host: flags.host, user: flags.user || DEFAULT_USER, key: flags.key || DEFAULT_KEY, port };
      saveCfg(c);
      }
    } else if (sub === "rm") {
      if (!c.profiles[name]) die(`No profile '${name}'`);
      const t = makeTarget(name, c.profiles[name]);
      if (t.transport === "ssh") { spawnSync("pkill", ["-f", `${t.port}:127.0.0.1:${AGENT_PORT} ${t.user}@${t.host}`]); rmSync(tokenFile(t), { force: true }); }
      delete c.profiles[name]; saveCfg(c);
    } else if (sub !== "list") die("usage: profile add|list|rm");
    print(Object.entries(c.profiles).map(([n, p]) => p.vm ? { name: n, transport: "azure", vm: p.vm, resourceGroup: p.resourceGroup, fqdn: p.fqdn, user: p.user, agentPort: p.agentPort, connect: p.connect } : { name: n, transport: "ssh", host: p.host, user: p.user || DEFAULT_USER, key: p.key || DEFAULT_KEY, localPort: p.port }));
    break;
  }
  case "install": { // first install only; an agent that already answers must be upgraded instead
    let t = target(); const cur = t.transport === "azure" && !t.fqdn ? null : await agentVersion(t);
    if (cur !== null) die(`The agent is already installed on '${t.name}' (version ${cur}). To update it: ${me(t)} upgrade`);
    if (t.transport === "azure") { t = await azureSetup(t, false); const v = await agentVersion(t); print({ profile: t.name, installed: v, reachable: v !== null, ...(v === null ? { note: `Installed, but this machine cannot reach ${t.connect || `${t.fqdn}:${t.agentPort}`}. The tool does not change the NSG: open TCP ${t.agentPort} to your address yourself, or set --connect via a tunnel/VPN.` } : {}) }); break; }
    await installAgent(t); print({ profile: t.name, installed: await agentVersion(t) }); break;
  }
  case "upgrade": { // replace the agent of an existing, working connection with this CLI's version
    let t = target(); const cur = await agentVersion(t);
    if (cur === null) die(`No agent answers on '${t.name}'. For a first install: ${me(t)} install`);
    if (cur >= AGENT_VERSION && !flags.force) { print({ profile: t.name, version: cur, upgraded: false, reason: "already up to date (use --force to reinstall)" }); break; }
    if (t.transport === "azure") t = await azureSetup(t, true); else await installAgent(t);
    print({ profile: t.name, from: cur, to: await agentVersion(t), upgraded: true }); break;
  }
  case "up": { const t = target(); await up(t); console.log(t.transport === "azure" ? "direct (mTLS) profile: no tunnel needed" : "tunnel up"); break; }
  case "down": { const t = target(); if (t.transport === "azure") { console.log("direct (mTLS) profile: no tunnel to close"); break; } spawnSync("pkill", ["-f", `${t.port}:127.0.0.1:${AGENT_PORT} ${t.user}@${t.host}`]); console.log(`tunnel down (${t.name})`); break; }
  case "status": { const t = target(); const tun = t.transport === "azure" ? true : await alive(t); let info = null; if (tun) info = await rpc("info").catch(() => null); print({ profile: t.name, transport: t.transport, host: t.host || t.fqdn, tunnel: t.transport === "azure" ? undefined : tun, agent: !!info, expectedVersion: AGENT_VERSION, upToDate: !!info && (info.version || 0) >= AGENT_VERSION, ...(info || {}) }); break; }
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
    print(await rpc("mouse", action === "scroll" ? { action, delta: v[0], x: v[1], y: v[2] } : { action, x: v[0], y: v[1], x2: v[2], y2: v[3] })); break;
  }
  case "exec": await runShell("cmd"); break;
  case "psexec": await runShell("powershell"); break;
  case "launch": print(await rpc("launch", { path: a[0], args: a.slice(1).join(" ") })); break;
  case "screenshot": {
    const out = a[0] || "windows-screenshot.png"; const r = await rpc("screenshot", { window: flags.window });
    writeFileSync(out, Buffer.from(r.png, "base64")); print({ saved: out, w: r.w, h: r.h, x: r.x, y: r.y }); break;
  }
  case "raw": print(await rpc(a[0], a[1] ? JSON.parse(a[1]) : {})); break;
  default: console.error(`Unknown command: ${cmd}\n`); console.log(USAGE); process.exit(1);
}
