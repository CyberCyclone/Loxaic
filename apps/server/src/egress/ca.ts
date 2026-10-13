/**
 * The egress proxy's certificate authority: what lets it read a sandbox's
 * HTTPS requests to GitHub (to add the token and apply rules.ts) while the
 * sandbox's own git, gh, curl and Node verify the connection as usual —
 * against this CA, which the sandbox is told to trust (env.ts) and nothing
 * else is.
 *
 * One CA per deployment, created on first use under `EGRESS_CA_DIR` (default
 * `<cwd>/egress-ca`; the desktop puts it under its data dir), key 0600. Leaf
 * certificates are made only for the hosts the proxy intercepts, kept in
 * memory, and share one key. Node can make keys but not certificates, hence
 * node-forge.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import path from "node:path";
import forge from "node-forge";

export interface EgressCa {
  certPem: string;
  /** For a host the proxy intercepts: a key and certificate it can serve. */
  leafFor(host: string): { key: string; cert: string };
}

export function egressCaDir(): string {
  return process.env.EGRESS_CA_DIR ?? path.join(process.cwd(), "egress-ca");
}

function newKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
}

function serial(): string {
  // Positive, so the leading bit is clear.
  const bytes = randomBytes(16);
  bytes[0] &= 0x7f;
  return bytes.toString("hex");
}

function createCa(): { certPem: string; keyPem: string } {
  const keyPem = newKeyPem();
  const key = forge.pki.privateKeyFromPem(keyPem);
  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.setRsaPublicKey(key.n, key.e);
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
  cert.validity.notAfter = new Date(Date.now() + 10 * 365 * 24 * 3600_000);
  const attrs = [
    { name: "commonName", value: "Loxaic sandbox egress CA" },
    { name: "organizationName", value: "Loxaic" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: "basicConstraints", cA: true, critical: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    { name: "subjectKeyIdentifier" },
  ]);
  cert.sign(key, forge.md.sha256.create());
  return { certPem: forge.pki.certificateToPem(cert), keyPem };
}

let loaded: EgressCa | null = null;

/** The deployment's CA, created on first use. */
export function egressCa(): EgressCa {
  if (loaded) return loaded;
  const dir = egressCaDir();
  const certPath = path.join(dir, "ca.pem");
  const keyPath = path.join(dir, "ca.key");
  let certPem: string;
  let keyPem: string;
  if (existsSync(certPath) && existsSync(keyPath)) {
    certPem = readFileSync(certPath, "utf8");
    keyPem = readFileSync(keyPath, "utf8");
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ({ certPem, keyPem } = createCa());
    writeFileSync(keyPath, keyPem, { mode: 0o600 });
    writeFileSync(certPath, certPem, { mode: 0o644 });
  }
  chmodSync(keyPath, 0o600);
  const caCert = forge.pki.certificateFromPem(certPem);
  const caKey = forge.pki.privateKeyFromPem(keyPem);
  const leafKeyPem = newKeyPem();
  const leafKey = forge.pki.privateKeyFromPem(leafKeyPem);
  const leaves = new Map<string, { key: string; cert: string }>();
  loaded = {
    certPem,
    leafFor(host) {
      const cached = leaves.get(host);
      if (cached) return cached;
      const cert = forge.pki.createCertificate();
      cert.publicKey = forge.pki.setRsaPublicKey(leafKey.n, leafKey.e);
      cert.serialNumber = serial();
      cert.validity.notBefore = new Date(Date.now() - 24 * 3600_000);
      cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000);
      cert.setSubject([{ name: "commonName", value: host }]);
      cert.setIssuer(caCert.subject.attributes);
      cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true, critical: true },
        { name: "extKeyUsage", serverAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: host }] },
      ]);
      cert.sign(caKey, forge.md.sha256.create());
      const leaf = { key: leafKeyPem, cert: forge.pki.certificateToPem(cert) };
      leaves.set(host, leaf);
      return leaf;
    },
  };
  return loaded;
}

/** Test seam: forget the loaded CA (a test points EGRESS_CA_DIR elsewhere). */
export function __resetEgressCaForTest(): void {
  loaded = null;
}
