/**
 * A stand-in for llama.cpp's releases on GitHub: the API that lists them and
 * the downloads themselves, plus a "third-party" archive at a plain address.
 *
 * Each release is a real archive whose `llama-server` is a wrapper around the
 * fake router (apps/server/test-fixtures/fake-llama-server.mjs), saying which
 * release it is. So choosing a version in the picker really downloads,
 * verifies, unpacks and starts something — and what it reports back is the
 * version that was chosen, not the fake every other spec runs.
 *
 * The releases, newest first:
 *   - a pre-release (to be labelled as one);
 *   - a good release;
 *   - a release whose build refuses a preset key Loxaic always writes — how an
 *     older llama.cpp or a fork really fails: fatally, at boot, naming the key;
 *   - a release with no build for the test machine;
 *   - a release GitHub publishes no checksum for;
 * and, behind "Load older versions", one more good one.
 *
 * The test machine is the fixed `linux-x64-vulkan` one the server uses under
 * its fake hardware (apps/server/src/llama/releases.ts `assetKey`), whatever
 * this suite runs on.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/test-fixtures/fake-llama-server.mjs');

export interface MockLlamaReleases {
  /** `LLAMA_RELEASES_API_URL`. */
  apiUrl: string;
  /** `LLAMA_RELEASES_URL`. */
  downloadUrl: string;
  tags: { prerelease: string; good: string; broken: string; noBuild: string; noChecksum: string; older: string };
  /** A third-party build: its address, what it hashes to, and what the fake
   * inside says its version is. */
  fork: { url: string; sha256: string; version: string };
  stop: () => Promise<void>;
}

interface Archive {
  bytes: Buffer;
  sha256: string;
}

/** A tar.gz holding `llama-<name>/llama-server`, padded so that a download
 * takes long enough to watch. */
function buildArchive(dir: string, name: string, extraEnv = ''): Archive {
  const src = path.join(dir, `src-${name}`);
  const inner = path.join(src, `llama-${name}`);
  mkdirSync(inner, { recursive: true });
  writeFileSync(
    path.join(inner, 'llama-server'),
    `#!/bin/sh\nexport LOXAIC_FAKE_VERSION=${name}\n${extraEnv}\nexec "${process.execPath}" "${FAKE}" "$@"\n`,
    { mode: 0o755 },
  );
  // Random, so gzip cannot shrink it away.
  writeFileSync(path.join(inner, 'libpadding.so'), randomBytes(1024 * 1024));
  const out = path.join(dir, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', src, '.']);
  const bytes = readFileSync(out);
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export async function startMockLlamaReleases(): Promise<MockLlamaReleases> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'loxaic-e2e-llama-'));
  const tags = { prerelease: 'b9104', good: 'b9103', broken: 'b9102', noBuild: 'b9101', noChecksum: 'b9100', older: 'b9050' };
  const vulkan = (tag: string) => `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`;
  const archives = new Map<string, Archive>();
  for (const tag of [tags.prerelease, tags.good, tags.noChecksum, tags.older]) {
    archives.set(`${tag}/${vulkan(tag)}`, buildArchive(dir, tag));
  }
  archives.set(`${tags.broken}/${vulkan(tags.broken)}`, buildArchive(dir, tags.broken, 'export LOXAIC_FAKE_REJECT_KEY=jinja'));
  const forkVersion = 'e2e-fork-1.0';
  const fork = buildArchive(dir, forkVersion);

  const release = (tag: string, opts: { prerelease?: boolean; digest?: boolean; macOnly?: boolean } = {}) => {
    const name = opts.macOnly ? `llama-${tag}-bin-macos-arm64.tar.gz` : vulkan(tag);
    const archive = archives.get(`${tag}/${name}`);
    return {
      tag_name: tag,
      prerelease: opts.prerelease === true,
      draft: false,
      published_at: `2026-0${String(9 - (9104 - Number(tag.slice(1))) % 9)}-15T12:00:00Z`,
      assets: [
        {
          name,
          size: archive?.bytes.length ?? 1234,
          digest: opts.digest === false ? null : `sha256:${archive?.sha256 ?? 'c'.repeat(64)}`,
        },
      ],
    };
  };
  // A full page of thirty, as GitHub sends when there are more: the five that
  // matter and twenty-five the server does not list (not `b<number>` tags).
  const filler = Array.from({ length: 25 }, (_, i) => ({ tag_name: `nightly-${String(i)}`, assets: [] }));
  const pageOne = [
    release(tags.prerelease, { prerelease: true }),
    release(tags.good),
    release(tags.broken),
    release(tags.noBuild, { macOnly: true }),
    release(tags.noChecksum, { digest: false }),
    ...filler,
  ];
  const pageTwo = [release(tags.older)];
  const all = [...pageOne.slice(0, 5), ...pageTwo];

  /** An archive in pieces, so the picker has a download to show. */
  const sendSlowly = (res: import('node:http').ServerResponse, bytes: Buffer): void => {
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': String(bytes.length) });
    const pieces = 8;
    const size = Math.ceil(bytes.length / pieces);
    let sent = 0;
    const next = (): void => {
      if (res.destroyed) return;
      if (sent >= bytes.length) {
        res.end();
        return;
      }
      res.write(bytes.subarray(sent, sent + size));
      sent += size;
      setTimeout(next, 250);
    };
    next();
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://mock');
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/repo/releases') {
      const page = url.searchParams.get('page') ?? '1';
      json(page === '1' ? pageOne : page === '2' ? pageTwo : []);
      return;
    }
    const byTag = /^\/repo\/releases\/tags\/([^/]+)$/.exec(url.pathname);
    if (byTag) {
      const found = all.find((r) => r.tag_name === byTag[1]);
      if (found) json(found);
      else json({ message: 'Not Found' }, 404);
      return;
    }
    const file = /^\/dl\/(.+)$/.exec(url.pathname);
    const archive = file ? archives.get(decodeURIComponent(file[1])) : url.pathname === '/fork/llama-fork.tar.gz' ? fork : undefined;
    if (archive) {
      sendSlowly(res, archive.bytes);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const base = `http://127.0.0.1:${String(port)}`;

  return {
    apiUrl: `${base}/repo`,
    downloadUrl: `${base}/dl`,
    tags,
    fork: { url: `${base}/fork/llama-fork.tar.gz`, sha256: fork.sha256, version: forkVersion },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}
