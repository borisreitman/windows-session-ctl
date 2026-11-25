// Azure helpers for the direct transport: find a VM by name, and run PowerShell on it with `az vm run-command`.
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function az(args, timeoutMs = 600000) {
  const r = spawnSync("az", [...args, "-o", "json"], { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error("Azure CLI (az) not found or failed to run: " + r.error.message);
  if (r.status !== 0) throw new Error((r.stderr || "az failed").trim().split("\n").filter((l) => !l.startsWith("WARNING")).join("\n"));
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

// Resolve everything the tool needs from the VM name (and optionally its resource group).
export function findVm(name, rg) {
  let group = rg;
  if (!group) {
    const hits = az(["vm", "list", "--query", `[?name=='${name}'].resourceGroup`]) || [];
    const sub = az(["account", "show", "--query", "name"]);
    if (!hits.length) throw new Error(`No VM named '${name}' in Azure subscription '${sub}'. Check \`az account show\` / \`az login\`, or pass --resource-group.`);
    if (hits.length > 1) throw new Error(`Several VMs named '${name}' (resource groups: ${hits.join(", ")}). Pass --resource-group.`);
    group = hits[0];
  }
  const vm = az(["vm", "show", "-d", "-g", group, "-n", name]);
  return {
    name, rg: group, fqdn: (vm.fqdns || "").split(",")[0] || null, ip: vm.publicIps || null,
    power: vm.powerState, os: vm.storageProfile?.osDisk?.osType, user: vm.osProfile?.adminUsername,
  };
}

// Find the VM that owns a DNS name or public IP (used when an ssh profile only knows its host).
export function findVmByHost(host) {
  const hit = (az(["vm", "list", "-d"]) || []).filter((v) => [v.fqdns, v.publicIps].some((x) => (x || "").toLowerCase().split(",").includes(host.toLowerCase())));
  if (hit.length === 1) return { name: hit[0].name, rg: hit[0].resourceGroup };
  const sub = az(["account", "show", "--query", "name"]);
  throw new Error(`No single VM with DNS name or IP '${host}' in Azure subscription '${sub}'. Pass --vm <name>.`);
}

// Run a PowerShell script on the VM as SYSTEM (session 0). Returns the script's stdout; throws with stderr on failure.
export function runPowerShell(rg, vm, script, timeoutMs = 600000) {
  const dir = mkdtempSync(join(tmpdir(), "wsc-az-")); const file = join(dir, "script.ps1");
  writeFileSync(file, script, { mode: 0o600 });
  try {
    const res = az(["vm", "run-command", "invoke", "-g", rg, "-n", vm, "--command-id", "RunPowerShellScript", "--scripts", `@${file}`], timeoutMs);
    const parts = res?.value || [];
    const pick = (kind) => parts.filter((v) => (v.code || "").includes(`/${kind}/`)).map((v) => v.message || "").join("\n").trim();
    if (parts.some((v) => /\/Std(Out|Err)\//.test(v.code || ""))) return { stdout: pick("StdOut"), stderr: pick("StdErr") }; // one entry per stream
    const msg = parts[0]?.message || ""; // older format: a single message with [stdout] / [stderr] markers
    const out = (msg.match(/\[stdout\]\n([\s\S]*?)\n?\[stderr\]/) || [, msg])[1];
    const err = (msg.match(/\[stderr\]\n([\s\S]*)$/) || [, ""])[1].trim();
    return { stdout: out, stderr: err };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
