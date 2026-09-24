import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';

/**
 * A stand-in for the HuggingFace Hub, pointed at by `HF_ENDPOINT` — the
 * variable HuggingFace's own tools read, and the one the server's client reads
 * at call time. It serves exactly what the Local models screen asks for:
 * search, a repo's details and file tree, its model card, and a file to
 * download (throttled, with Range, so progress and pause/resume are
 * observable).
 *
 * Repo names carry a per-run suffix: downloaded models are rows in a database
 * shared with every other run, and a leftover row with the same id would make
 * the next run's download a 409.
 *
 * The quant sizes are chosen against the fake runtime's one 24 GB GPU so each
 * fit label appears: a tiny downloadable quant (will fit), one near the limit
 * (might fit), and one far past it (won't fit). Only the tiny one is ever
 * downloaded; the others are listed with sizes their bytes never back up.
 */

const GiB = 1024 ** 3;
export const MOCK_GPU_BYTES = 24 * GiB;

/** A small but valid GGUF: header, the metadata the server reads, padding. */
function buildGguf(padTo: number): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    return b;
  };
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const kv = (key: string, type: number, value: Buffer) => Buffer.concat([str(key), u32(type), value]);
  const out = Buffer.concat([
    Buffer.from('GGUF', 'ascii'),
    u32(3),
    u64(0),
    u64(3),
    kv('general.architecture', 8, str('llama')),
    kv('llama.block_count', 4, u32(22)),
    kv('llama.context_length', 4, u32(32768)),
  ]);
  return Buffer.concat([out, Buffer.alloc(Math.max(0, padTo - out.length))]);
}

export interface MockHfRepos {
  /** Downloadable; three quants in three fit bands. */
  tiny: string;
  /** Far too large at any quant — its search result reads "Won't fit". */
  huge: string;
  /** A vision model with a projector. */
  vision: string;
}

export interface MockHf {
  url: string;
  repos: MockHfRepos;
  /** The downloadable quant, and the one that is cancelled mid-download. */
  quants: { download: string; cancel: string; mightFit: string; wontFit: string };
  stop: () => Promise<void>;
}

const CARD = `---
license: apache-2.0
---
# Tiny Test Model

A **small** model for the end-to-end suite. It answers briefly and fits on anything.

- Trained on nothing in particular
- Useful for testing downloads
`;

export async function startMockHf(): Promise<MockHf> {
  const run = randomBytes(3).toString('hex');
  const repos: MockHfRepos = {
    tiny: `e2e-org/Tiny-${run}-GGUF`,
    huge: `e2e-org/Huge-${run}-GGUF`,
    vision: `pixel-lab/Vision-${run}-GGUF`,
  };
  const sha = createHash('sha1').update(run).digest('hex');
  // 12 MB served at ~1.5 MB/s: about eight seconds, long enough to see
  // progress and to pause part-way.
  const tinyBody = buildGguf(12 * 1024 * 1024);
  const tinySha = createHash('sha256').update(tinyBody).digest('hex');
  const cancelBody = buildGguf(24 * 1024 * 1024);
  const cancelSha = createHash('sha256').update(cancelBody).digest('hex');

  interface File { path: string; size: number; sha: string; body?: Buffer }
  const tree: Record<string, File[]> = {
    [repos.tiny]: [
      // Unsloth's naming, deliberately: the real router rewrites a "UD-" quant
      // in a preset section name, and a downloaded Unsloth model once shipped
      // unusable because every quant here was already in the router's form.
      { path: 'Tiny-UD-Q4_K_XL.gguf', size: tinyBody.length, sha: tinySha, body: tinyBody },
      { path: 'Tiny-Q5_K_M.gguf', size: cancelBody.length, sha: cancelSha, body: cancelBody },
      { path: 'Tiny-Q8_0.gguf', size: Math.round(21 * GiB), sha: 'c'.repeat(64) },
      { path: 'Tiny-F16.gguf', size: 40 * GiB, sha: 'd'.repeat(64) },
    ],
    [repos.huge]: [{ path: 'Huge-Q4_K_M.gguf', size: 120 * GiB, sha: 'e'.repeat(64) }],
    [repos.vision]: [
      { path: 'Vision-Q4_K_M.gguf', size: 3 * GiB, sha: 'f'.repeat(64) },
      { path: 'mmproj-F16.gguf', size: 600 * 1024 * 1024, sha: 'a'.repeat(64) },
    ],
  };
  const summaries = [
    {
      id: repos.tiny, author: 'e2e-org', downloads: 12_345, downloadsAllTime: 99_000, likes: 42, trendingScore: 7,
      createdAt: '2026-01-02T00:00:00.000Z', lastModified: '2026-09-01T00:00:00.000Z', gated: false,
      pipeline_tag: 'text-generation', tags: ['gguf', 'license:apache-2.0'],
      cardData: { license: 'apache-2.0', base_model: 'e2e-org/Tiny', language: ['en'] },
      gguf: { total: 1_100_000_000, architecture: 'llama', context_length: 32768 },
    },
    {
      id: repos.huge, author: 'e2e-org', downloads: 500, likes: 3, pipeline_tag: 'text-generation', gated: 'manual',
      cardData: { license: 'other' }, gguf: { total: 200_000_000_000, architecture: 'llama', context_length: 131072 },
    },
    {
      id: repos.vision, author: 'pixel-lab', downloads: 800, likes: 9, pipeline_tag: 'image-text-to-text',
      cardData: { license: 'mit' }, gguf: { total: 4_000_000_000, architecture: 'gemma3', context_length: 131072 },
    },
    // Not a chat model: the server must drop it from results.
    { id: `e2e-org/Image-${run}-GGUF`, author: 'e2e-org', pipeline_tag: 'text-to-image' },
  ];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/api/models') {
      const q = (url.searchParams.get('search') ?? '').toLowerCase();
      const author = url.searchParams.get('author');
      const pipeline = url.searchParams.get('pipeline_tag');
      send(
        200,
        summaries.filter(
          (s) =>
            (!q || s.id.toLowerCase().includes(q)) &&
            (!author || s.author === author) &&
            (!pipeline || s.pipeline_tag === pipeline),
        ),
      );
      return;
    }
    const repoInfo = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(url.pathname);
    if (repoInfo) {
      const s = summaries.find((x) => x.id === repoInfo[1]);
      if (s) send(200, { ...s, sha });
      else send(404, { error: 'not found' });
      return;
    }
    const treeMatch = /^\/api\/models\/([^/]+\/[^/]+)\/tree\/([0-9a-f]+)$/.exec(url.pathname);
    if (treeMatch) {
      const files = tree[treeMatch[1]] ?? [];
      send(
        200,
        files.map((f) => ({ type: 'file', path: f.path, size: f.size, lfs: { oid: f.sha, size: f.size } })),
      );
      return;
    }
    const resolve = /^\/([^/]+\/[^/]+)\/resolve\/([0-9a-f]+)\/(.+)$/.exec(url.pathname);
    if (resolve) {
      const [, repo, , file] = resolve;
      if (file === 'README.md') {
        res.writeHead(repo === repos.tiny ? 200 : 404, { 'content-type': 'text/markdown' });
        res.end(repo === repos.tiny ? CARD : '');
        return;
      }
      const f = (tree[repo] ?? []).find((x) => x.path === decodeURIComponent(file));
      if (!f?.body) {
        send(404, { error: 'not found' });
        return;
      }
      const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
      const start = range ? Number(range[1]) : 0;
      const body = f.body.subarray(start);
      res.writeHead(range ? 206 : 200, { 'content-length': String(body.length) });
      let at = 0;
      const tick = setInterval(() => {
        if (res.destroyed) {
          clearInterval(tick);
          return;
        }
        const next = body.subarray(at, at + 150 * 1024);
        at += next.length;
        if (next.length === 0) {
          clearInterval(tick);
          res.end();
        } else res.write(next);
      }, 100);
      return;
    }
    send(404, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    repos,
    quants: { download: 'UD-Q4_K_XL', cancel: 'Q5_K_M', mightFit: 'Q8_0', wontFit: 'F16' },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => { resolve(); });
      }),
  };
}
