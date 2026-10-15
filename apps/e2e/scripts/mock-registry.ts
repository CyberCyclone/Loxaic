/**
 * A private container registry for the custom-image specs (#253): a real
 * `registry:2` with htpasswd auth, published on a fixed loopback port, holding
 * two images the harness builds and pushes at stand-up.
 *
 * - `e2e/marker:1`: Debian with a marker file, a non-root user and an
 *   ENTRYPOINT of its own — a stranger's image that Loxaic can run.
 * - `e2e/nosetsid:1`: the same base with util-linux's `setsid` removed — one
 *   Loxaic must refuse, naming what is missing.
 *
 * A fixed port, not an ephemeral one: Docker Desktop's engine reaches a
 * published ephemeral port from the host's side only, so the server's pulls
 * (which the engine makes) could never reach it.
 *
 * Nothing here runs `docker login`, which would write a credential into the
 * machine's Docker config that every later pull could fall back on. The push
 * goes over the Engine API with the login in its own header instead.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createServer } from 'node:net';

export const REGISTRY_USERNAME = 'loxaic-e2e';
export const REGISTRY_PASSWORD = 'registry-e2e-password';
/** `htpasswd -nbB loxaic-e2e registry-e2e-password`: registry:2 accepts only
 * bcrypt, and nothing in the tree computes it. */
const HTPASSWD = 'loxaic-e2e:$2y$05$wLqdt.jQw.WbIbH5CoPHjeCZsON7AhjT.hM83bjWGVxyp/mo4RkY2\n';
const LABEL = 'loxaic.e2e=registry';

export interface MockRegistry {
  host: string;
  marker: string;
  noSetsid: string;
  stop: () => Promise<void>;
}

function docker(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (b: Buffer) => { out += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(`docker ${args.join(' ')} failed (${String(code)}): ${err.trim()}`));
    });
    child.stdin.end(input ?? '');
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => { resolve(typeof address === 'object' && address ? address.port : 0); });
    });
  });
}

function dockerSocket(): string {
  const host = process.env.DOCKER_HOST;
  return host?.startsWith('unix://') ? host.slice('unix://'.length) : '/var/run/docker.sock';
}

/** Pushes `image` with the registry login carried in the request itself. */
function push(image: string, host: string): Promise<void> {
  const [name, tag] = [image.slice(0, image.lastIndexOf(':')), image.slice(image.lastIndexOf(':') + 1)];
  const auth = Buffer.from(JSON.stringify({ username: REGISTRY_USERNAME, password: REGISTRY_PASSWORD, serveraddress: host })).toString('base64');
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath: dockerSocket(),
        method: 'POST',
        path: `/images/${encodeURIComponent(name)}/push?tag=${encodeURIComponent(tag)}`,
        headers: { 'X-Registry-Auth': auth },
      },
      (res) => {
        let body = '';
        res.on('data', (b: Buffer) => { body += b.toString(); });
        res.on('end', () => {
          const failed = body.split('\n').find((line) => line.includes('"error"'));
          if (res.statusCode !== 200 || failed) reject(new Error(`push of ${image} failed: ${failed ?? body}`));
          else resolve();
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function build(tag: string, dockerfile: string): Promise<void> {
  await docker(['build', '-q', '-t', tag, '-'], dockerfile);
}

export async function startMockRegistry(): Promise<MockRegistry> {
  // Anything a crashed earlier run left behind.
  const stale = await docker(['ps', '-aq', '--filter', `label=${LABEL}`]).catch(() => '');
  for (const id of stale.split('\n').filter(Boolean)) await docker(['rm', '-f', '-v', id]).catch(() => '');

  const port = await freePort();
  const host = `localhost:${String(port)}`;
  const id = await docker([
    'create', '--label', LABEL,
    '-p', `127.0.0.1:${String(port)}:5000`,
    '-e', 'REGISTRY_AUTH=htpasswd',
    '-e', 'REGISTRY_AUTH_HTPASSWD_REALM=loxaic-e2e',
    '-e', 'REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd',
    'registry:2',
  ]);
  // In before the first start: the registry reads its password file once,
  // and makes up a random one when there is none.
  const staging = mkdtempSync(path.join(tmpdir(), 'loxaic-registry-'));
  try {
    mkdirSync(path.join(staging, 'auth'));
    writeFileSync(path.join(staging, 'auth', 'htpasswd'), HTPASSWD, 'utf8');
    await docker(['cp', path.join(staging, 'auth'), `${id}:/auth`]);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  await docker(['start', id]);
  for (let i = 0; i < 50; i++) {
    const answered = await fetch(`http://127.0.0.1:${String(port)}/v2/`).then(() => true, () => false);
    if (answered) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  const marker = `${host}/e2e/marker:1`;
  const noSetsid = `${host}/e2e/nosetsid:1`;
  await build(marker, [
    'FROM debian:bookworm-slim',
    'RUN useradd -m -u 1234 builder && echo custom-image-marker > /opt/marker',
    'USER builder',
    'ENTRYPOINT ["sh", "-c", "echo ran > /tmp/entrypoint-ran; exec sleep infinity"]',
  ].join('\n'));
  await build(noSetsid, ['FROM debian:bookworm-slim', 'RUN rm -f /usr/bin/setsid'].join('\n'));
  await push(marker, host);
  await push(noSetsid, host);

  return {
    host,
    marker,
    noSetsid,
    stop: async () => {
      await docker(['rm', '-f', '-v', id]).catch(() => '');
      // The server's pulls tag these too; removing by name takes both.
      await docker(['rmi', '-f', marker, noSetsid]).catch(() => '');
    },
  };
}
