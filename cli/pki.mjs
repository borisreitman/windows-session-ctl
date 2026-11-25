// Local PKI for the direct (mTLS) transport: a CA, one client certificate, and signing of the VM's server CSR.
// The CA key and the client key never leave this machine; the VM's server key never leaves the VM.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const PKI_DIR = join(homedir(), ".config", "windows-session-ctl", "pki");
export const CA_CRT = join(PKI_DIR, "ca.crt"), CLIENT_CRT = join(PKI_DIR, "client.crt"), CLIENT_KEY = join(PKI_DIR, "client.key");
const CA_KEY = join(PKI_DIR, "ca.key");

function openssl(args, input) {
  const r = spawnSync("openssl", args, { encoding: "utf8", input });
  if (r.error) throw new Error("openssl not found on PATH");
  if (r.status !== 0) throw new Error(`openssl ${args[0]} failed: ${(r.stderr || "").trim()}`);
  return r.stdout;
}
const serial = () => "0x" + randomBytes(12).toString("hex");
const priv = (f) => chmodSync(f, 0o600);

export function ensurePki() {
  mkdirSync(PKI_DIR, { recursive: true, mode: 0o700 });
  if (!existsSync(CA_CRT) || !existsSync(CA_KEY)) {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", CA_KEY]); priv(CA_KEY);
    const cnf = join(PKI_DIR, "ca.cnf");
    writeFileSync(cnf, "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=windows-session-ctl CA\n" +
      "[v3]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n");
    openssl(["req", "-x509", "-new", "-key", CA_KEY, "-config", cnf, "-days", "3650", "-sha256", "-out", CA_CRT]);
  }
  if (!existsSync(CLIENT_CRT) || !existsSync(CLIENT_KEY)) {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", CLIENT_KEY]); priv(CLIENT_KEY);
    const csr = join(PKI_DIR, "client.csr"), ext = join(PKI_DIR, "client.ext");
    openssl(["req", "-new", "-key", CLIENT_KEY, "-subj", `/CN=windows-session-ctl client (${hostname()})`, "-out", csr]);
    writeFileSync(ext, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n");
    openssl(["x509", "-req", "-in", csr, "-CA", CA_CRT, "-CAkey", CA_KEY, "-set_serial", serial(), "-days", "825", "-sha256", "-extfile", ext, "-out", CLIENT_CRT]);
    rmSync(csr, { force: true });
  }
}
export const caPem = () => readFileSync(CA_CRT, "utf8");

// Sign the CSR produced on the VM as a TLS server certificate for `fqdn` (CSR subject/extensions are ignored).
export function signServerCsr(csrPem, fqdn) {
  if (!/^[A-Za-z0-9.-]+$/.test(fqdn)) throw new Error(`refusing to issue a certificate for '${fqdn}'`);
  const dir = PKI_DIR, csr = join(dir, "server.csr"), ext = join(dir, "server.ext"), out = join(dir, "server.crt");
  writeFileSync(csr, csrPem);
  writeFileSync(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${fqdn}\n`);
  openssl(["x509", "-req", "-in", csr, "-CA", CA_CRT, "-CAkey", CA_KEY, "-set_serial", serial(), "-days", "730", "-sha256", "-extfile", ext, "-out", out]);
  const pem = readFileSync(out, "utf8"); rmSync(csr, { force: true }); rmSync(out, { force: true }); return pem;
}
