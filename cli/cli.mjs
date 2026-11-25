#!/usr/bin/env node
// windows-session-ctl: drive the Windows desktop session a user is logged into (RDP or console), over SSH.
//   ssh profile:   CLI --HTTP+token--> ssh tunnel (127.0.0.1:LOCAL) --> agent.ps1 in the desktop session
//   https profile: CLI --HTTPS, mutual TLS--> agent.ps1   (installed through `az vm run-command`, no SSH);
//                  with --connect on a loopback port, the same through an SSH tunnel opened on demand
import { spawnSync, spawn } from "node:child_process";
import net from "node:net";
import https from "node:https";
import tls from "node:tls";
import { ensurePki, signServerCsr, createServerPfx, caPem, CA_CRT, CLIENT_CRT, CLIENT_KEY } from "./pki.mjs";
import { findVm, findVmByHost, runPowerShell } from "./azure.mjs";
import { csrScript, installScript, upgradeScript, manualInstallScript, manualUpgradeScript } from "./vm-scripts.mjs";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CFG_DIR = join(homedir(), ".config", "windows-session-ctl");
const CFG_FILE = join(CFG_DIR, "config.json");
const TOKEN_DIR = join(CFG_DIR, "tokens");
const AGENT_PORT = 8766;
const DEFAULT_TLS_PORT = 8443;
const rdir = (t) => `C:\\Users\\${t.user}\\Downloads\\windows-session-ctl`; // install dir on the VM
const AGENT_VERSION = 14; // keep in step with $Version in agent/agent.ps1

const USAGE = `Drive the Windows desktop session a user is logged into (RDP or console), over SSH.

  windows-session-ctl profile add <name> [--transport ssh] --host H [--user U] [--key K] [--port P]   SSH tunnel
  windows-session-ctl profile add <name> [--transport https] --vm <azure-vm> [--resource-group RG] [--agent-port P] [--connect host:port] [--key K]   mutual TLS (--host H instead of --vm for non-Azure)
                                         transport is a per-profile setting: ssh | https (default: https with --vm, else ssh)
  windows-session-ctl profile list | rm <name>      (alias: profiles)
  windows-session-ctl --profile <name> <command>    pick a profile (-p, or $WINSESSION_PROFILE); optional when only one exists
  windows-session-ctl -p <name> install [--ssh|--az] [profile options]   first install of the agent (never automatic)
        --ssh: copy over SSH, use the SSH tunnel      --az: az run-command, use HTTPS with mutual TLS
        either one records that transport in the profile; without a flag: the profile's, else https with --vm, ssh with --host
        ssh:   --host H | --vm NAME   [--user U] [--key K] [--port P]
        https: --vm NAME | --host H   [--resource-group RG] [--user U] [--agent-port P] [--connect host:port] [--key K]
               --connect 127.0.0.1:<port> reaches the agent through an SSH tunnel that is opened automatically (--user, --key)
  windows-session-ctl -p <name> install --manual --host H [--user U] [--agent-port P] [--connect host:port] [--key K] [--out DIR]
        https without ssh/Azure: write certificates, agent and install.ps1 to copy by hand (default dir tmp/windows-session-ctl-<name>-install)
        every install creates the profile if it is new (no \`profile add\` needed); options already stored in profile <name> may be omitted
  windows-session-ctl upgrade --manual [--out DIR]              same for upgrading such a machine
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
  windows-session-ctl screenshot [path] [--window <w> [--control <name|id>]] [--rect x,y,w,h]
        capture the screen, a window, a control or a rectangle (counted from the window's top left with --window)
  windows-session-ctl wait <criteria> [--timeout s] [--interval ms] [--tolerance 0-255]
        wait until every criterion is on screen (default 60 s, every 500 ms); prints a JSON array with one entry per
        place found, each with "rect" {x,y,w,h} (see it with: screenshot out.png --rect x,y,w,h) and "center";
        if not found within --timeout it prints [] and exits with 124
        criteria: --text <string> | --image <file>, repeatable; the image is copied to Windows once
        where to look: --window <w> [--control <name|id>] applies to the criteria AFTER it; --screen goes back to all of it
  windows-session-ctl launch <exe> [args]           start a program in the session, do not wait
  windows-session-ctl exec <cmd-command> [--timeout s]  run a CMD command/batch script in the session (arg, or stdin when piped), wait, print stdout; exit code passed through
  windows-session-ctl psexec <powershell> [--timeout s]  same, for PowerShell
  windows-session-ctl raw <method> [json-params]

Output: one JSON document on stdout, errors as {"error": ...} with a non-zero exit; progress and warnings go to stderr.
Exception: exec and psexec pass the program's own output through.
Window names match exactly first, then by substring. Coordinates are screen pixels as in screenshots.
Profile: --profile/-p, $WINSESSION_PROFILE, or the only profile if there is just one; with several and none chosen the command fails and lists them.
Ad hoc: WINSESSION_HOST (+ _USER, _KEY, _PORT) bypasses profiles. Prefer \`tree\`/\`find\`/\`click\` over screenshots.`;

let passthrough = false; // exec / psexec relay a program's own output, so their errors are plain text on stderr
const die = (m) => { if (passthrough) console.error(m); else console.log(JSON.stringify({ error: m.replace(/^error: /, "") }, null, 2)); process.exit(1); };
process.on("uncaughtException", (e) => die(`error: ${e.message}`));
const TRANSPORTS = ["ssh", "https"];
const DEFAULT_USER = "azureuser", DEFAULT_KEY = join(homedir(), ".ssh", "id_ed25519");
function loadCfg() {
  let c = existsSync(CFG_FILE) ? JSON.parse(readFileSync(CFG_FILE, "utf8")) : {};
  if (c.host && !c.profiles) { // legacy single-target config -> a profile named "default"
    const { host, user, key, port } = c;
    c = { profiles: { default: { transport: "ssh", host, user, key, port: port || AGENT_PORT } } };
    saveCfg(c);
  }
  c.profiles ||= {};
  const implicit = Object.values(c.profiles).filter((p) => !p.transport); // older profiles: write the setting down
  if (implicit.length) { for (const p of implicit) p.transport = p.vm ? "https" : "ssh"; saveCfg(c); }
  return c;
}
function saveCfg(c) { mkdirSync(CFG_DIR, { recursive: true }); writeFileSync(CFG_FILE, JSON.stringify(c, null, 2) + "\n"); }
function makeTarget(name, p) {
  if (p.transport === "https") return { name, transport: "https", vm: p.vm, rg: p.resourceGroup, user: p.user, fqdn: p.fqdn || p.host, agentPort: Number(p.agentPort || DEFAULT_TLS_PORT), connect: p.connect, sshHost: p.host || p.fqdn, key: p.key || DEFAULT_KEY };
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
  if (!names.length) die("No profiles. Install on a machine to add one: windows-session-ctl -p <name> install --ssh --host <dns-name-or-ip> (or --az --vm <azure-vm>, or --manual --host H)");
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
    const req = https.request({ agent: false, host: h, port: Number(pt), ...(!net.isIP(t.fqdn) && { servername: t.fqdn }), checkServerIdentity: (_, c) => tls.checkServerIdentity(t.fqdn, c), path: "/command", method: "POST", // agent:false: a pooled socket would be dead after an agent restart
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
  if (t.transport === "https") return httpsCall(t, method, params);
  const res = await fetch(`http://127.0.0.1:${t.port}/command`, {
    method: "POST", headers: { "X-Token": tok, "content-type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  return { status: res.status, body: await res.json() };
}
// The SSH tunnel this tool runs for a target: always for ssh; for https when --connect names a loopback port.
function tunnelOf(t) {
  if (t.transport === "ssh") return { local: t.port, remote: AGENT_PORT, host: t.host, user: t.user, key: t.key };
  const local = Number((/^(?:127\.0\.0\.1|localhost):(\d+)$/.exec(t.connect || "") || [])[1]);
  return local && t.sshHost ? { local, remote: t.agentPort, host: t.sshHost, user: t.user || DEFAULT_USER, key: t.key } : null;
}
const killTunnel = (n) => spawnSync("pkill", ["-f", `ssh .*-L ${n.local}:127.0.0.1:${n.remote} `]);
let tunnelError = "";
async function alive(port) { return new Promise((res) => { const s = net.connect(port, "127.0.0.1"); s.setTimeout(1500); s.on("connect", () => { s.destroy(); res(true); }); s.on("error", () => res(false)); s.on("timeout", () => { s.destroy(); res(false); }); }); }
async function up(t) { // open the tunnel if this target uses one and nothing listens on its local port yet
  const n = tunnelOf(t); tunnelError = "";
  if (!n || await alive(n.local)) return;
  const p = spawn("ssh", [...sshBase(n), "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
    "-L", `${n.local}:127.0.0.1:${n.remote}`, `${n.user}@${n.host}`], { detached: true, stdio: "ignore" });
  p.unref();
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 300)); if (await alive(n.local)) return; }
  const failed = `Could not open the SSH tunnel to ${n.user}@${n.host}.`;
  if (t.transport === "https") { tunnelError = failed; return; } // the call itself then fails and reports this too
  die(`${failed} Check SSH access; for an Azure VM without SSH use: ${me(t)} install --az`);
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
let checked = false, lastError = "";
async function tryCall(t, method, params) {
  if (t.transport === "https") return call(t, method, params).catch((e) => { lastError = e.message; return null; });
  let tok = existsSync(tokenFile(t)) ? readFileSync(tokenFile(t), "utf8") : "";
  let r = tok ? await call(t, method, params, tok).catch(() => null) : null;
  if (!r || r.status === 401) { // stale token or agent restarted: re-read it from the VM
    const f = ssh(t, `type "${rdir(t)}\\token"`);
    if (f.code === 0 && f.out) { storeToken(t, f.out); r = await call(t, method, params, f.out).catch(() => null); }
  }
  return r;
}
async function azureSetup(t, upgrade, settings = {}) {
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
  c.profiles[t.name] = { ...prev, ...settings, transport: "https", vm: vm.name, resourceGroup: vm.rg, user, fqdn: vm.fqdn, agentPort: t.agentPort };
  saveCfg(c);
  return makeTarget(t.name, c.profiles[t.name]);
}
function profileFor(name, method) { // the stored profile (if any) overlaid with this command's options
  const profiles = loadCfg().profiles, p = { ...profiles[name], transport: method };
  if (flags.user) p.user = flags.user;
  if (flags.key) p.key = flags.key;
  if (flags.vm && flags.vm !== p.vm) { // another VM: what was derived from the old one no longer holds
    if (p.vm) { delete p.resourceGroup; delete p.fqdn; if (!flags.host) delete p.host; }
    p.vm = flags.vm;
  }
  if (flags["resource-group"]) p.resourceGroup = flags["resource-group"];
  if (flags.host && flags.host !== p.host) {
    p.host = flags.host; delete p.fqdn;
    if (!flags.vm) { delete p.vm; delete p.resourceGroup; }
  }
  if (!p.vm && !p.host) die(`Profile '${name}' needs a machine: add ${method === "https" ? "--vm <azure-vm> (or --host H)" : "--host H (or --vm <azure-vm>)"}`);
  if (method === "https") {
    if (!p.vm) { console.error(`Looking up the Azure VM behind ${p.host}...`); const v = findVmByHost(p.host); p.vm = v.name; p.resourceGroup = v.rg; }
    p.agentPort = Number(flags["agent-port"] || p.agentPort || DEFAULT_TLS_PORT);
    if (flags.connect) p.connect = flags.connect;
  } else {
    if (!p.host) { console.error(`Looking up the address of Azure VM ${p.vm}...`); const v = findVm(p.vm, p.resourceGroup); p.host = v.fqdn || v.ip; p.user ||= v.user;
      if (!p.host) die(`VM '${v.name}' has no public DNS name or IP; pass --host`); }
    p.key ||= DEFAULT_KEY; p.user ||= DEFAULT_USER;
    const others = Object.entries(profiles).filter(([n]) => n !== name).map(([, o]) => o);
    if (flags.port) {
      if (others.some((o) => o.transport === "ssh" && Number(o.port) === Number(flags.port))) die(`local port ${flags.port} is used by another profile`);
      p.port = Number(flags.port);
    }
    if (!p.port) { const used = new Set(others.map((o) => Number(o.port))); p.port = AGENT_PORT; while (used.has(p.port)) p.port++; }
  }
  return p;
}
function saveProfile(name, p) { const c = loadCfg(); c.profiles[name] = p; saveCfg(c); }
// The profile `install` works on. It need not exist: with --host or --vm, an unknown name creates it.
function installProfileName() {
  const names = Object.keys(loadCfg().profiles), want = flags.profile || process.env.WINSESSION_PROFILE;
  if (!want && !names.length) die("Name the new profile: windows-session-ctl -p <name> install ... --host <dns-name-or-ip> (or --vm <azure-vm>)");
  if (want && !names.includes(want)) {
    if (flags.host || flags.vm) { // the machine is given here: exactly this name, never a prefix of another profile
      if (!/^[\w.-]+$/.test(want)) die("profile names may use letters, digits, . _ - only");
      return want;
    }
    if (!names.some((n) => n.startsWith(want))) die(`No profile '${want}' yet. To create it, add --host <dns-name-or-ip> or --vm <azure-vm>`);
  }
  return target().name;
}
// An SSH tunnel opened for settings that are not saved (yet) must neither be reused nor outlive a failed install.
let unsaved = null;
process.on("exit", () => { if (unsaved) killTunnel(unsaved); });
async function freshTunnel(n) {
  killTunnel(n);
  for (let i = 0; i < 20 && await alive(n.local); i++) await new Promise((r) => setTimeout(r, 100));
  if (await alive(n.local)) die(`local port ${n.local} is in use by something else; pass --port`);
  unsaved = n;
}
// What decides which machine is talked to, and how.
const route = (t) => JSON.stringify(t.transport === "ssh" ? [t.transport, t.host, t.user, t.key, t.port] : [t.transport, t.vm, t.rg, t.fqdn, t.agentPort, t.connect, t.key]);
// Write the files for a hand-carried install / upgrade into a new folder.
function writePackage(t, kind) {
  const dir = flags.out || join("tmp", `windows-session-ctl-${t.name}-${kind}`); // relative to where you run the command
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const put = (name, data) => writeFileSync(join(dir, name), data, { mode: 0o600 });
  put("agent.ps1", readFileSync(join(ROOT, "agent", "agent.ps1")));
  if (kind === "install") {
    createServerPfx(t.fqdn, join(dir, "server.pfx"));
    put("ca.crt", caPem()); put("install.ps1", manualInstallScript({ user: t.user, port: t.agentPort }));
  } else put("upgrade.ps1", manualUpgradeScript({ user: t.user }));
  return dir;
}
const manualSteps = (t, dir, kind) => [
  `Copy the folder ${dir} to the Windows machine (any way you like).`,
  `There, in an elevated PowerShell inside that folder: powershell -ExecutionPolicy Bypass -File .\\${kind}.ps1${t.user ? "" : " [-User <desktop user>]"}`,
  `Someone must be logged in on that machine's desktop. TCP ${t.agentPort} must be reachable from here.`,
  `Then check: ${me(t)} status`,
  ...(kind === "install" ? [`The folder holds the server's private key (server.pfx, not password protected): delete your copy afterwards.`] : []),
];
async function install() {
  if ([flags.ssh, flags.az, flags.manual].filter(Boolean).length > 1) die("choose one of --ssh, --az or --manual");
  if (flags.manual) { // https without any remote channel
    if (process.env.WINSESSION_HOST) die("install --manual saves a profile: unset WINSESSION_HOST");
    const name = installProfileName(), saved = loadCfg().profiles[name], old = saved || {};
    const host = flags.host || old.fqdn || old.host; if (!host) die(`Profile '${name}' has no DNS name or IP yet: add --host H`);
    const p = { ...old, transport: "https", host, fqdn: host, agentPort: Number(flags["agent-port"] || old.agentPort || DEFAULT_TLS_PORT), ...(flags.user && { user: flags.user }), ...(flags.key && { key: flags.key }), ...(flags.connect && { connect: flags.connect }) };
    const t = makeTarget(name, p);
    if (!flags.force && old.transport === "https" && old.fqdn && (await agentVersion(t)) !== null) die(`The agent already answers on '${t.name}'. To update it: ${me(t)} upgrade --manual   (--force makes a new install package anyway)`);
    const dir = writePackage(t, "install"); saveProfile(t.name, p);
    return print({ profile: t.name, ...(!saved && { created: true }), transport: "https", package: dir, next: manualSteps(t, dir, "install") });
  }
  const adHoc = !!process.env.WINSESSION_HOST;
  const name = adHoc ? target().name : installProfileName();
  const saved = adHoc ? undefined : loadCfg().profiles[name];
  const method = flags.az ? "https" : flags.ssh ? "ssh" : flags.transport || (adHoc ? "ssh" : saved?.transport || (flags.vm ? "https" : "ssh"));
  if (!TRANSPORTS.includes(method)) die(`--transport must be one of: ${TRANSPORTS.join(", ")}`);
  if (adHoc && method === "https") die("install --az needs a saved profile (not WINSESSION_HOST)");
  if (method === "https" && !flags.az && !flags.vm && !saved?.vm) die(`'${name}' has no Azure VM. Use: windows-session-ctl -p ${name} install --manual  (or --az)`);
  const p = adHoc ? null : profileFor(name, method);
  let t = p ? makeTarget(name, p) : target();
  const changed = !!p && (!saved || route(makeTarget(name, saved)) !== route(t));
  const created = p && !saved ? { created: true } : {};
  if (changed && method === "ssh") await freshTunnel(tunnelOf(t));
  const cur = t.transport === "https" && !t.fqdn ? null : await agentVersion(t);
  if (cur !== null) {
    if (!changed) die(`The agent is already installed on '${t.name}' (version ${cur}). To update it: ${me(t)} upgrade`);
    saveProfile(name, p); unsaved = null; // it already answers with these settings: just record them
    return print({ profile: name, ...created, transport: method, installed: cur, note: `Agent already answers over ${method}; nothing reinstalled, profile ${saved ? "updated" : "added"}.${cur < AGENT_VERSION ? ` It is older than this CLI: run ${me(t)} upgrade` : ""}` });
  }
  if (method === "https") t = await azureSetup(t, false, p); // saves the profile once the VM-side install succeeded
  else { await installAgent(t); if (p) saveProfile(name, p); unsaved = null; }
  const v = await agentVersion(t);
  print({ profile: t.name, ...created, transport: method, installed: v, reachable: v !== null, ...(v === null && { note: `Installed, but this machine cannot reach ${t.connect || `${t.fqdn}:${t.agentPort}`}.${tunnelError ? ` ${tunnelError}` : ""} ${tunnelOf(t) ? "Check SSH access (--user, --key)." : `The tool does not change the NSG: open TCP ${t.agentPort} to your address yourself, use a VPN, or tunnel over SSH with --connect 127.0.0.1:18443.`}` }) });
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
    if ((!p || !p.body.ok) && t.transport === "https") die(`No agent answers on ${t.connect || `${t.fqdn || t.vm}:${t.agentPort}`} (mutual TLS)${lastError ? `: ${lastError}` : ""}.${tunnelError ? ` ${tunnelError}` : ""} If it is installed, the port is probably not reachable from here: the tool never changes the NSG, so open TCP ${t.agentPort} to your address yourself, use a VPN, or tunnel over SSH with --connect 127.0.0.1:18443. Not installed yet: ${me(t)} install${t.vm ? "" : " --manual"}`);
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
const print = (v) => console.log(JSON.stringify(v ?? null, null, 2)); // stdout carries JSON only

// `wait`: turn the ordered flags into criteria. Scope flags apply to the criteria that follow them.
function waitCriteria() {
  const criteria = [], images = new Map(); let window, control, unused;
  for (const [flag, value] of waitArgs) {
    if (flag !== "--screen" && !value) die(`wait: ${flag} needs a value`);
    if (flag === "--text") criteria.push({ window, control, text: value });
    else if (flag === "--image") {
      const data = readFileSync(value), image = createHash("sha256").update(data).digest("hex");
      images.set(image, { file: value, data }); criteria.push({ window, control, image });
    } else if (flag === "--window") { window = value; control = undefined; }
    else if (flag === "--control") { if (!window) die("wait: --control needs a --window before it"); control = value; }
    else window = control = undefined; // --screen
    unused = flag === "--text" || flag === "--image" ? undefined : flag;
  }
  if (unused) die(`wait: no --text or --image after ${unused}; put --window/--control/--screen before the criteria they apply to`);
  if (!criteria.length) die("wait: give at least one --text <string> or --image <file>");
  return { criteria, images };
}
async function runWait() {
  if (a.length) die(`wait: unexpected argument '${a[0]}' (use --text or --image)`);
  const { criteria, images } = waitCriteria();
  const number = (name, fallback, max = Infinity) => { const v = Number(flags[name] ?? fallback); if (!(v >= 0 && v <= max)) die(`wait: bad --${name} '${flags[name]}'`); return v; };
  const timeout = number("timeout", 60), interval = number("interval", 500), tolerance = number("tolerance", 10, 255);
  const start = Date.now(), check = () => rpc("check", { criteria, tolerance });
  for (;;) {
    let r = await check();
    if (r.missing.length) { // images the machine does not have yet
      for (const hash of r.missing) { console.error(`copying ${images.get(hash).file} to Windows...`); await rpc("putimage", { hash, data: images.get(hash).data.toString("base64") }); }
      r = await check();
      if (r.missing.length) die("error: the agent did not keep the image");
    }
    const elapsed = (Date.now() - start) / 1000, matched = r.results.every((x) => x.matches.length);
    if (matched) { // one array entry per place found
      return print(r.results.flatMap((x, i) => { const { image, ...q } = criteria[i];
        return x.matches.map((m) => ({ ...(image && { image: images.get(image).file }), ...q, ...m,
          center: { x: m.rect.x + (m.rect.w >> 1), y: m.rect.y + (m.rect.h >> 1) } })); }));
    }
    if (elapsed >= timeout) {
      const missing = r.results.flatMap((x, i) => { const q = criteria[i]; return x.matches.length ? [] :
        [`${q.image ? `image ${images.get(q.image).file}` : `text "${q.text}"`}${q.window ? ` in window "${q.window}"` : ""}${x.reason ? ` (${x.reason})` : ""}`]; });
      print([]); console.error(`wait: not found after ${elapsed.toFixed(1)} s: ${missing.join("; ")}`);
      process.exitCode = 124; return;
    }
    await new Promise((res) => setTimeout(res, Math.min(interval, (timeout - elapsed) * 1000)));
  }
}

// ---- args ----
const argv = process.argv.slice(2);
const flags = {}; const pos = []; const waitArgs = []; // wait's criteria and scopes, in order
const VALUE_FLAGS = ["--window", "--control", "--timeout", "--profile", "--rect"], PROFILE_FLAGS = ["--host", "--user", "--key", "--port", "--vm", "--resource-group", "--agent-port", "--connect", "--transport", "--out"];
for (let i = 0; i < argv.length; i++) {
  if (["--force", "--ssh", "--az", "--manual"].includes(argv[i])) { flags[argv[i].slice(2)] = true; continue; }
  const f = argv[i] === "-p" ? "--profile" : argv[i];
  if (pos[0] === "wait") {
    if (f === "--screen") { waitArgs.push([f]); continue; }
    if (["--window", "--control", "--text", "--image"].includes(f)) { waitArgs.push([f, argv[++i]]); continue; }
    if (["--interval", "--tolerance"].includes(f)) { flags[f.slice(2)] = argv[++i]; continue; }
  }
  if (VALUE_FLAGS.includes(f) || (["profile", "install", "upgrade"].includes(pos[0]) && PROFILE_FLAGS.includes(f))) flags[f.slice(2)] = argv[++i];
  else pos.push(argv[i]);
}
const [cmd, ...a] = pos;
passthrough = cmd === "exec" || cmd === "psexec";
if (!cmd || cmd === "help" || cmd === "--help") { print({ usage: USAGE.split("\n") }); process.exit(cmd ? 0 : 1); }

switch (cmd) {
  case "profile": case "profiles": {
    const c = loadCfg(); const sub = cmd === "profiles" ? "list" : a[0] || "list"; const name = a[1];
    if (sub === "add") {
      const transport = flags.transport || (flags.vm ? "https" : "ssh");
      if (!TRANSPORTS.includes(transport)) die(`--transport must be one of: ${TRANSPORTS.join(", ")}`);
      const wrong = (transport === "https" ? ["port"] : ["vm", "resource-group", "agent-port", "connect"]).filter((f) => flags[f]);
      if (wrong.length) die(`${wrong.map((f) => "--" + f).join(", ")} ${wrong.length > 1 ? "do" : "does"} not apply to --transport ${transport} (https takes --vm or --host; ssh takes --host)`);
      if (transport === "https") { // direct mutual TLS: no SSH, no local tunnel port
        if (!flags.vm === !flags.host) die("--transport https needs exactly one of --vm <azure-vm-name> or --host <dns-name-or-ip> (non-Azure: install --manual)");
        if (!name) die("usage: profile add <name> --transport https (--vm <azure-vm> | --host H) [--agent-port P] [--connect host:port]");
        if (flags.vm && !/^[\w.-]+$/.test(flags.vm)) die("odd VM name");
        const keep = c.profiles[name] && c.profiles[name].vm === flags.vm && c.profiles[name].host === flags.host ? c.profiles[name] : {};
        c.profiles[name] = { ...keep, transport, ...(flags.vm ? { vm: flags.vm } : { host: flags.host }), ...(flags["resource-group"] && { resourceGroup: flags["resource-group"] }), ...(flags.user && { user: flags.user }), ...(flags.key && { key: flags.key }),
          agentPort: Number(flags["agent-port"] || keep.agentPort || DEFAULT_TLS_PORT), ...(flags.connect && { connect: flags.connect }) };
        if (!flags.connect) delete c.profiles[name].connect;
        saveCfg(c);
      } else {
      if (!name || !flags.host) die("usage: profile add <name> --host H [--user U] [--key K] [--port P]  |  profile add <name> --vm <azure-vm>");
      if (!/^[\w.-]+$/.test(name)) die("profile names may use letters, digits, . _ - only");
      const used = new Set(Object.entries(c.profiles).filter(([n, p]) => n !== name && p.transport === "ssh").map(([, p]) => Number(p.port)));
      let port = Number(flags.port || c.profiles[name]?.port || 0);
      if (!port) { port = AGENT_PORT; while (used.has(port)) port++; }
      if (used.has(port)) die(`local port ${port} is used by another profile`);
      c.profiles[name] = { transport, host: flags.host, user: flags.user || DEFAULT_USER, key: flags.key || DEFAULT_KEY, port };
      saveCfg(c);
      }
    } else if (sub === "rm") {
      if (!c.profiles[name]) die(`No profile '${name}'`);
      const t = makeTarget(name, c.profiles[name]);
      const n = tunnelOf(t); if (n) killTunnel(n);
      if (t.transport === "ssh") rmSync(tokenFile(t), { force: true });
      delete c.profiles[name]; saveCfg(c);
    } else if (sub !== "list") die("usage: profile add|list|rm");
    print(Object.entries(c.profiles).map(([n, p]) => p.transport === "https" ? { name: n, transport: "https", host: p.vm ? undefined : p.host, vm: p.vm, resourceGroup: p.resourceGroup, fqdn: p.fqdn, user: p.user, key: p.key, agentPort: p.agentPort, connect: p.connect } : { name: n, transport: "ssh", host: p.host, user: p.user || DEFAULT_USER, key: p.key || DEFAULT_KEY, localPort: p.port }));
    break;
  }
  case "install": await install(); break;
  case "upgrade": { // replace the agent of an existing, working connection with this CLI's version
    let t = target();
    if (flags.manual) { // writes the files only; the running version cannot be assumed reachable
      if (t.transport !== "https") die("upgrade --manual is for https profiles");
      const dir = writePackage(t, "upgrade"); print({ profile: t.name, package: dir, next: manualSteps(t, dir, "upgrade") }); break;
    }
    if (t.transport === "https" && !t.vm) die(`'${t.name}' was installed by hand. Use: ${me(t)} upgrade --manual`);
    const cur = await agentVersion(t);
    if (cur === null) die(`No agent answers on '${t.name}'. For a first install: ${me(t)} install`);
    if (cur >= AGENT_VERSION && !flags.force) { print({ profile: t.name, version: cur, upgraded: false, reason: "already up to date (use --force to reinstall)" }); break; }
    if (t.transport === "https") t = await azureSetup(t, true); else await installAgent(t);
    print({ profile: t.name, from: cur, to: await agentVersion(t), upgraded: true }); break;
  }
  case "up": { const t = target(); if (!tunnelOf(t)) { print({ profile: t.name, tunnel: false, note: "direct (mTLS) profile: no tunnel needed" }); break; } await up(t); if (tunnelError) die(tunnelError); print({ profile: t.name, tunnel: true }); break; }
  case "down": { const t = target(), n = tunnelOf(t); if (n) killTunnel(n); print({ profile: t.name, tunnel: false, ...(!n && { note: "direct (mTLS) profile: no tunnel to close" }) }); break; }
  case "status": { const t = target(), n = tunnelOf(t); let info = null; if (t.transport === "https" || await alive(n.local)) info = await rpc("info").catch(() => null); print({ profile: t.name, transport: t.transport, host: t.host || t.fqdn, tunnel: n ? await alive(n.local) : undefined, agent: !!info, expectedVersion: AGENT_VERSION, upToDate: !!info && (info.version || 0) >= AGENT_VERSION, ...(info || {}) }); break; }
  case "info": print(await rpc("info")); break;
  case "windows": print(await rpc("windows")); break;
  case "tree": print(await rpc("tree", { window: a[0], depth: a[1] })); break;
  case "find": print(await rpc("find", { window: a[0], query: a[1] })); break;
  case "focus": print(await rpc("focus", { window: a[0] })); break;
  case "click": print(await rpc("invoke", { window: a[0], name: a[1] })); break;
  case "settext": print(await rpc("settext", { window: a[0], text: a.slice(1).join(" "), name: flags.control })); break;
  case "gettext": print(await rpc("gettext", { window: a[0], name: flags.control })); break;
  case "type": print(await rpc("type", { text: a.join(" "), window: flags.window })); break;
  case "key": print(await rpc("key", { keys: a[0], window: flags.window })); break;
  case "mouse": {
    const [action, ...n] = a; const v = n.map(Number);
    print(await rpc("mouse", action === "scroll" ? { action, delta: v[0], x: v[1], y: v[2] } : { action, x: v[0], y: v[1], x2: v[2], y2: v[3] })); break;
  }
  case "exec": await runShell("cmd"); break;
  case "psexec": await runShell("powershell"); break;
  case "launch": print(await rpc("launch", { path: a[0], args: a.slice(1).join(" ") })); break;
  case "wait": {
    if (flags.window || flags.control) die("wait: put --window/--control after the word wait, before the criteria they apply to");
    await runWait(); break;
  }
  case "screenshot": {
    if (flags.control && !flags.window) die("screenshot: --control needs --window");
    let rect;
    if ("rect" in flags) {
      const m = /^\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*$/.exec(flags.rect || "");
      if (!m || !Number(m[3]) || !Number(m[4])) die("screenshot: --rect takes x,y,width,height in pixels, e.g. --rect 456,913,25,25");
      const [x, y, w, h] = m.slice(1).map(Number); rect = { x, y, w, h };
    }
    const out = a[0] || "windows-screenshot.png"; const r = await rpc("screenshot", { window: flags.window, control: flags.control, rect });
    writeFileSync(out, Buffer.from(r.png, "base64")); print({ saved: out, w: r.w, h: r.h, x: r.x, y: r.y }); break;
  }
  case "raw": print(await rpc(a[0], a[1] ? JSON.parse(a[1]) : {})); break;
  default: die(`Unknown command: ${cmd} (see: windows-session-ctl help)`);
}
