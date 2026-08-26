import type { Conversation } from '../types'

export const CONVERSATIONS: Conversation[] = [
  {
    id: 'c1',
    title: 'Rust vs Go for CLI tools',
    kind: 'chat',
    time: '5h ago',
    model: 'm1',
    location: 'server',
    msgs: [
      {
        role: 'user',
        text: 'I need to build a CLI tool that parses large CSV files and outputs JSON. Should I use Rust or Go? Performance matters but so does development speed.',
      },
      {
        role: 'assistant',
        model: 'm1',
        thinking: 'The user is asking about a classic Rust vs Go tradeoff for a CLI tool. Key factors:\n\n1. Performance: Rust will be faster for raw parsing.\n2. CSV parsing: Both have excellent libraries.\n3. Development speed: Go is generally faster to write.\n4. Memory: Rust gives more control.\n5. Distribution: Both compile to single binaries.',
        text: 'Good question — both are excellent for CLI tools, but the right choice depends on your priorities.\n\n**Quick comparison for your CSV→JSON use case:**\n\n| | Rust | Go |\n|---|---|---|\n| Parsing speed | Faster (zero-copy) | Fast enough |\n| Memory control | Fine-grained | GC-managed |\n| Dev speed | Slower | Faster |\n| Error handling | `Result<T,E>` | `if err != nil` |\n| Binary size | Smaller | Slightly larger |\n\n**If files are truly massive (>1GB):** Rust. You can memory-map the file and parse without loading it all.\n\n**If development speed matters more:** Go.\n\n```rust\nuse csv::Reader;\nuse serde_json::json;\n\nfn csv_to_json<R: io::Read>(reader: R) -> io::Result<String> {\n    let mut rdr = Reader::from_reader(reader);\n    let headers = rdr.headers()?.clone();\n    let mut records = Vec::new();\n    for result in rdr.records() {\n        let record = result?;\n        let mut row = serde_json::Map::new();\n        for (i, val) in record.iter().enumerate() {\n            row.insert(headers[i].to_string(), json!(val));\n        }\n        records.push(json!(row));\n    }\n    Ok(serde_json::to_string_pretty(&records)?)\n}\n```',
        usage: { in: 4200, out: 890, tps: 42, cache: 71 },
        forks: ['main', 'fork A — serde-zero-copy', 'fork B — polars route'],
      },
      {
        role: 'user',
        text: "Let's go with Rust. Can you show me how to stream the JSON output instead of building it all in memory?",
      },
      {
        role: 'assistant',
        model: 'm1',
        thinking: 'Streaming JSON output keeps memory flat regardless of file size. Write each object as you parse it.',
        text: 'Absolutely — streaming keeps memory flat regardless of file size.\n\n```rust\nuse csv::Reader;\nuse serde_json::{json, Serializer};\n\nfn csv_to_json_stream<R: io::Read, W: io::Write>(reader: R, mut writer: W) -> io::Result<()> {\n    let mut rdr = Reader::from_reader(reader);\n    let headers = rdr.headers()?.clone();\n    writer.write_all(b"[")?;\n    let mut first = true;\n    for result in rdr.records() {\n        let record = result?;\n        if !first { writer.write_all(b",")?; }\n        first = false;\n        let mut obj = serde_json::Map::new();\n        for (i, val) in record.iter().enumerate() {\n            obj.insert(headers[i].to_string(), json!(val));\n        }\n        let mut ser = Serializer::new(&mut writer);\n        serde_json::Value::Object(obj).serialize(&mut ser)?;\n    }\n    writer.write_all(b"]")?;\n    Ok(())\n}\n```\n\n**Memory profile:** ~O(1) — just the current CSV record, regardless of file size.',
        usage: { in: 3800, out: 620, tps: 41, cache: 78 },
      },
    ],
  },
  {
    id: 'c2',
    title: 'Refactor auth middleware',
    kind: 'agent',
    time: '2h ago',
    model: 'm1',
    location: 'server',
    msgs: [
      {
        role: 'user',
        text: 'Can you look at the auth middleware in this workspace and suggest improvements? I think the error handling is inconsistent.',
      },
      {
        role: 'assistant',
        model: 'm1',
        thinking: 'I should first read the file to see what they have, then analyze the error handling patterns.',
        tools: [
          {
            tool: 'fs_read',
            summary: 'src/auth/middleware.ts',
            result: 'export function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.replace("Bearer ", "");\n  if (!token) return res.status(401).json({ error: "No token" });\n  try {\n    const decoded = jwt.verify(token, SECRET);\n    req.user = decoded;\n    next();\n  } catch (e) {\n    return res.status(401).json({ error: e.message });\n  }\n}',
          },
          {
            tool: 'grep',
            summary: '"res.status" in src/auth/',
            result: 'src/auth/middleware.ts:5:  if (!token) return res.status(401).json({ error: "No token" });\nsrc/auth/middleware.ts:9:    return res.status(401).json({ error: e.message });\nsrc/auth/index.ts:12:  return res.status(403).json({ error: "Forbidden" });\nsrc/auth/refresh.ts:8:  return res.status(400).json({ error: "Missing refresh token" });',
          },
        ],
        text: "I've reviewed your middleware. Here are the issues:\n\n**1. Inconsistent error shapes**\n- Line 5: `{ error: \"No token\" }` — string\n- Line 9: `{ error: e.message }` — dynamic string\n\n**2. JWT secret is hardcoded**\n`SECRET` is referenced directly. This should be injected via config.\n\n**3. No distinction between expired and invalid tokens**\n\n**Suggested fix:**\n\n```typescript\nexport class AuthError extends Error {\n  constructor(message: string, public code: string, public statusCode: number = 401) {\n    super(message);\n    this.name = \"AuthError\";\n  }\n}\n```",
        usage: { in: 8400, out: 1240, tps: 38, cache: 62 },
        forks: ['main', 'fork A — use Result<T,E> pattern', 'fork B — fastify hooks instead'],
      },
    ],
  },
  {
    id: 'c3',
    title: 'Explain CRDTs',
    kind: 'chat',
    time: '1d ago',
    model: 'm2',
    location: 'server',
    msgs: [
      {
        role: 'user',
        text: 'Can you explain Conflict-free Replicated Data Types? I keep hearing about them in the context of local-first software.',
      },
      {
        role: 'assistant',
        model: 'm2',
        thinking: 'CRDTs are a deep topic. Explain from first principles: the problem, the insight, two families, practical examples.',
        text: 'CRDTs (Conflict-free Replicated Data Types) are data structures that can be replicated across multiple nodes, updated independently, and merged without conflicts — ever.\n\n**The problem they solve:** In a distributed system, two nodes might update the same data simultaneously. Traditional approaches (locking, consensus) are slow. CRDTs guarantee that **any merge order produces the same final state**.\n\n**The mathematical guarantee:**\n- Commutative: A ∪ B = B ∪ A\n- Associative: (A ∪ B) ∪ C = A ∪ (B ∪ C)\n- Idempotent: A ∪ A = A\n\n**Two families:**\n\n1. **State-based (CvRDT):** Each node sends its entire state. Merge is a `join()` function.\n\n```rust\nstruct GCounter {\n    counts: HashMap<NodeId, u64>,\n}\n\nimpl GCounter {\n    fn increment(&mut self, node: NodeId) {\n        *self.counts.entry(node).or_default() += 1;\n    }\n    fn value(&self) -> u64 { self.counts.values().sum() }\n    fn merge(&mut self, other: &GCounter) {\n        for (node, &count) in &other.counts {\n            let my = self.counts.entry(*node).or_default();\n            *my = (*my).max(count);\n        }\n    }\n}\n```\n\n2. **Operation-based (CmRDT):** Nodes send operations. More efficient but requires reliable delivery.\n\n**Real-world implementations:**\n- **Yjs** — used by Notion, Evernote\n- **Automerge** — used by Ink & Switch\n- **Riak** — uses CRDTs for counters, sets, and maps',
        usage: { in: 6200, out: 980, tps: 28, cache: 55 },
        forks: ['main'],
      },
    ],
  },
  {
    id: 'c4',
    title: 'Daily standup summary',
    kind: 'routine',
    time: '6h ago',
    model: 'm3',
    location: 'device',
    msgs: [
      {
        role: 'user',
        text: '[Routine: Daily standup summary — auto-generated prompt]',
      },
      {
        role: 'assistant',
        model: 'm3',
        origin: 'device',
        thinking: 'This is a routine run. I need to read yesterday\'s git commits, summarize what changed, flag anything risky.',
        tools: [
          {
            tool: 'bash',
            summary: 'git log --since=yesterday --oneline',
            result: 'a3f2c1d feat: add WebSocket reconnection logic\nb8e4f0a fix: handle expired JWT tokens gracefully\nc1d2e3f refactor: extract auth utils into separate module\nd4e5f6a chore: update dependencies (express 4.18→4.19)\ne5f6a7b test: add integration tests for auth flow',
          },
        ],
        text: "## Daily Standup — August 10\n\n**Yesterday's activity:** 5 commits across `src/auth/` and `src/ws/`\n\n### What changed\n- **WebSocket reconnection** added — new `ReconnectingWebSocket` class with exponential backoff\n- **JWT expiry handling** fixed — now returns `TOKEN_EXPIRED` code\n- **Auth utilities extracted** — `verifyToken`, `signToken` moved to `src/auth/utils.ts`\n- **Dependencies updated** — Express 4.18→4.19\n- **Integration tests** added — 12 new test cases\n\n### Flags\n- **Express patch update.** Review the changelog for breaking changes.\n- **WebSocket reconnection.** Backoff logic is new and untested under network partitions.\n\n### Today\n- Review the WebSocket reconnection PR\n- Merge auth refactor after CI passes\n- Consider adding a JWT refresh endpoint (mentioned in issue #142)",
        usage: { in: 1800, out: 420, tps: 55, cache: 82 },
      },
    ],
  },
  {
    id: 'c5',
    title: 'Debug WebSocket reconnect',
    kind: 'agent',
    time: '1d ago',
    model: 'm1',
    location: 'server',
    msgs: [
      {
        role: 'user',
        text: 'My WebSocket client keeps reconnecting every 30 seconds even when the connection is stable. Why does it keep reconnecting?',
      },
      {
        role: 'assistant',
        model: 'm1',
        thinking: 'The issue is likely a server-side idle timeout. The client is not sending keepalive pings.',
        tools: [
          { tool: 'grep', summary: '"ping" or "pong" in src/', result: '(no matches found)' },
          { tool: 'bash', summary: 'curl -s -I wss://api.example.com 2>&1', result: 'HTTP/1.1 426 Upgrade Required\nConnection: close\nKeep-Alive: timeout=30' },
        ],
        text: "Found it. The server has a **30-second idle timeout** (`Keep-Alive: timeout=30`), and your client isn't sending keepalive pings.\n\n**Fix:** Add a periodic ping:\n\n```javascript\nws.onopen = () => {\n  pingInterval = setInterval(() => {\n    if (ws.readyState === WebSocket.OPEN) {\n      ws.send(JSON.stringify({ type: \"ping\" }));\n    }\n  }, 25000);\n};\n```\n\n**Three improvements:**\n1. **Ping interval** — heartbeat every 25s\n2. **Normal close check** — `code 1000` means intentional close\n3. **Error handler** — log errors for debugging",
        usage: { in: 5200, out: 480, tps: 40, cache: 68 },
        forks: ['main', 'fork A — use reconnecting-websocket library'],
      },
    ],
  },
  {
    id: 'c6',
    title: 'K8s manifest generator',
    kind: 'chat',
    time: '2d ago',
    model: 'm2',
    location: 'server',
    msgs: [
      {
        role: 'user',
        text: 'Can you write a script that generates Kubernetes manifests from a simple YAML config?',
      },
      {
        role: 'assistant',
        model: 'm2',
        thinking: 'Practical tool request. Define a simple input format, use Python with PyYAML.',
        text: "Here's a Python script that takes a simple service definition and generates K8s manifests:\n\n```python\n#!/usr/bin/env python3\nimport yaml, sys\n\ndef generate_deployment(svc):\n    return {\n        \"apiVersion\": \"apps/v1\",\n        \"kind\": \"Deployment\",\n        \"metadata\": {\"name\": svc[\"name\"]},\n        \"spec\": {\n            \"replicas\": svc.get(\"replicas\", 1),\n            \"template\": {\n                \"spec\": {\"containers\": [{\n                    \"name\": svc[\"name\"],\n                    \"image\": svc[\"image\"],\n                }]}\n            }\n        }\n    }\n```\n\nRun `./gen-k8s.py services.yaml -o manifests/` and it generates deployment, service, and ingress YAMLs.",
        usage: { in: 4800, out: 720, tps: 27, cache: 60 },
        forks: ['main'],
      },
    ],
  },
]

export const PROMPT_SUGGESTIONS = [
  { title: 'Explain a concept', desc: 'Break down CRDTs, consensus algorithms, or distributed systems topics' },
  { title: 'Review my code', desc: 'Analyze a workspace file for bugs, patterns, or improvements' },
  { title: 'Write a script', desc: 'Generate a utility, migration, or automation tool' },
  { title: 'Debug an issue', desc: 'Diagnose errors, trace logs, and propose fixes' },
]
