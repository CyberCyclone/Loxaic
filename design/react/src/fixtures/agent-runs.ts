import type { AgentRun } from '../types'

export const AGENT_RUNS: AgentRun[] = [
  {
    id: 'a1',
    title: 'Refactor auth middleware',
    target: 'Loxaic/design',
    state: 'done',
    mode: 'manual',
    prompt: 'Can you look at the auth middleware in this workspace and suggest improvements? I think the error handling is inconsistent.',
    messages: [
      {
        role: 'assistant',
        model: 'm1',
        thinking: 'I should read the auth middleware file, then grep for all error responses to find inconsistencies.',
        tools: [
          { tool: 'fs_read', summary: 'src/auth/middleware.ts', result: 'export function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.replace("Bearer ", "");\n  if (!token) return res.status(401).json({ error: "No token" });\n  try {\n    const decoded = jwt.verify(token, SECRET);\n    req.user = decoded;\n    next();\n  } catch (e) {\n    return res.status(401).json({ error: e.message });\n  }\n}', duration: '0.3s' },
          { tool: 'grep', summary: '"res.status" in src/auth/', result: 'src/auth/middleware.ts:5:  if (!token) return res.status(401).json({ error: "No token" });\nsrc/auth/middleware.ts:9:    return res.status(401).json({ error: e.message });\nsrc/auth/index.ts:12:  return res.status(403).json({ error: "Forbidden" });\nsrc/auth/refresh.ts:8:  return res.status(400).json({ error: "Missing refresh token" });', duration: '0.2s' },
        ],
        text: "I've reviewed your middleware. Here are the issues:\n\n**1. Inconsistent error shapes** — strings vs dynamic messages\n**2. JWT secret hardcoded** — should be environment-injected\n**3. No expired vs invalid token distinction**\n\nWant me to apply the fix?",
        usage: { in: 8400, out: 1240, tps: 38, cache: 62 },
      },
      {
        role: 'assistant',
        model: 'm1',
        thinking: 'The user approved. I need to write the new error classes and refactor the middleware.',
        tools: [
          {
            tool: 'fs_edit',
            summary: 'src/auth/middleware.ts',
            duration: '0.1s',
            result: '',
            diff: [
              { type: 'meta', text: '--- src/auth/middleware.ts' },
              { type: 'meta', text: '+++ src/auth/middleware.ts' },
              { type: 'ctx', text: ' export function authMiddleware(req, res, next) {' },
              { type: 'del', text: '  const token = req.headers.authorization?.replace("Bearer ", "");' },
              { type: 'del', text: '  if (!token) return res.status(401).json({ error: "No token" });' },
              { type: 'add', text: '  const token = extractToken(req.headers.authorization);' },
              { type: 'add', text: '  if (!token) throw new AuthError("No token provided", "NO_TOKEN");' },
              { type: 'ctx', text: '   try {' },
              { type: 'del', text: '    const decoded = jwt.verify(token, SECRET);' },
              { type: 'add', text: '    const decoded = verifyToken(token);' },
              { type: 'ctx', text: '     req.user = decoded;' },
            ],
          },
          { tool: 'bash', summary: 'npm test -- src/auth/', result: 'PASS  src/auth/middleware.test.ts\nPASS  src/auth/errors.test.ts\nTests: 14 passed', duration: '2.4s' },
        ],
        text: "Changes applied and tests pass. The middleware now uses typed `AuthError` subclasses and the JWT secret is injected via config.",
        usage: { in: 5200, out: 480, tps: 40, cache: 68 },
      },
    ],
    todos: [
      { text: 'Read auth middleware', done: true },
      { text: 'Grep for all error responses', done: true },
      { text: 'Write AuthError classes', done: true },
      { text: 'Refactor middleware', done: true },
      { text: 'Run tests', done: true },
    ],
    changedFiles: [
      { path: 'src/auth/middleware.ts', adds: 12, dels: 8 },
      { path: 'src/auth/errors.ts', adds: 24, dels: 0 },
      { path: 'src/auth/utils.ts', adds: 6, dels: 2 },
    ],
    contextPercent: 34,
  },
  {
    id: 'a2',
    title: 'Debug WebSocket reconnect loop',
    target: 'Loxaic/api',
    state: 'awaiting_approval',
    mode: 'manual',
    prompt: 'My WebSocket client keeps reconnecting every 30 seconds even when the connection is stable.',
    messages: [
      {
        role: 'assistant',
        model: 'm1',
        thinking: 'The issue is likely a server-side idle timeout. The client is not sending keepalive pings.',
        tools: [
          { tool: 'grep', summary: '"ping" or "pong" in src/', result: '(no matches found)', duration: '0.2s' },
          { tool: 'bash', summary: 'curl -s -I wss://api.example.com', result: 'HTTP/1.1 426 Upgrade Required\nConnection: close\nKeep-Alive: timeout=30', duration: '0.5s' },
        ],
        text: "Found it. The server has a **30-second idle timeout**. I'll add a ping interval — requesting permission to edit `src/ws/client.ts`.",
        usage: { in: 5200, out: 480, tps: 40, cache: 68 },
      },
    ],
    todos: [
      { text: 'Search for ping/pong handlers', done: true },
      { text: 'Check server timeout', done: true },
      { text: 'Add ping interval to client', done: false },
      { text: 'Test reconnection behavior', done: false },
    ],
    changedFiles: [],
    contextPercent: 18,
  },
  {
    id: 'a3',
    title: 'Add JWT refresh endpoint',
    target: 'Loxaic/api',
    state: 'running',
    mode: 'auto',
    prompt: 'Add a JWT refresh token endpoint that accepts a valid refresh token and returns a new access token.',
    messages: [
      {
        role: 'assistant',
        model: 'm1',
        thinking: 'I need to create a refresh token route, validate the refresh token, and return a new access token. Let me first check the existing auth structure.',
        tools: [
          { tool: 'fs_read', summary: 'src/auth/index.ts', result: 'export function verifyToken(token: string) {\n  return jwt.verify(token, config.jwtSecret);\n}', duration: '0.2s' },
          { tool: 'fs_write', summary: 'src/auth/refresh.ts (new)', result: 'Created src/auth/refresh.ts', duration: '0.1s' },
        ],
        text: 'Creating the refresh endpoint...',
        usage: { in: 3400, out: 320, tps: 36, cache: 70 },
      },
    ],
    todos: [
      { text: 'Read existing auth structure', done: true },
      { text: 'Create refresh route', done: true },
      { text: 'Add token rotation logic', done: false },
      { text: 'Write integration tests', done: false },
    ],
    changedFiles: [
      { path: 'src/auth/refresh.ts', adds: 48, dels: 0 },
    ],
    contextPercent: 22,
  },
]
