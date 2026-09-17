/**
 * Streamable-HTTP mock MCP server (run as a process through
 * test-fixtures/mock-mcp-http-server.ts). Lives under src so tests can import
 * it; tsconfig's rootDir is src.
 *
 * Streamable-HTTP variant of the mock MCP fixture, for exercising the http
 * transport path (including the allowPrivateNetwork override, since it binds
 * to localhost), and standing in for GitHub's hosted MCP server.
 *
 * Importable (`startMockMcpHttp`) for server tests, and runnable for the e2e
 * harness, which has no MCP SDK of its own:
 *   pnpm exec tsx test-fixtures/mock-mcp-http-server.ts   # listens on :4009/mcp
 *
 * With a bearer configured (`requireBearer`, or MOCK_MCP_HTTP_TOKEN when run),
 * any other Authorization header is refused with a 401 whose body *echoes the
 * header it was given* — which is what a careless real server might do, and so
 * what redaction has to survive. `GET /__e2e/auth` reports how many requests
 * arrived and the last Authorization header seen, so a test can prove the
 * token reached the server rather than inferring it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface MockMcpHttp {
  url: string;
  /** Requests received on /mcp, refused ones included. */
  requests(): number;
  lastAuthorization(): string | undefined;
  close(): Promise<void>;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "mock-mcp-http", version: "1.0.0" });
  server.registerTool(
    "ping",
    { description: "Returns pong plus the given text.", inputSchema: { text: z.string().optional() } },
    ({ text }) => Promise.resolve({ content: [{ type: "text" as const, text: `pong${text ? `: ${text}` : ""}` }] }),
  );
  // Named after GitHub's own tool, so the GitHub server's default read-only
  // policy applies to it exactly as it would against the real endpoint.
  server.registerTool(
    "get_me",
    { description: "Returns the authenticated GitHub user.", inputSchema: {} },
    () => Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify({ login: "e2e-bot" }) }] }),
  );
  return server;
}

export async function startMockMcpHttp(opts: { port?: number; requireBearer?: string } = {}): Promise<MockMcpHttp> {
  let requests = 0;
  let lastAuthorization: string | undefined;

  const httpServer: Server = createServer((req, res) => {
    void (async () => {
      if (req.url === "/__e2e/auth") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ requests, lastAuthorization: lastAuthorization ?? null }));
        return;
      }
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }
      requests++;
      lastAuthorization = req.headers.authorization;
      if (opts.requireBearer && req.headers.authorization !== `Bearer ${opts.requireBearer}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: `Bad credentials: ${req.headers.authorization ?? "(none)"}` }));
        return;
      }
      // Stateless mode: a fresh server+transport per request keeps the fixture tiny.
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })();
  });

  await new Promise<void>((resolve) => httpServer.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/mcp`,
    requests: () => requests,
    lastAuthorization: () => lastAuthorization,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.closeAllConnections();
        httpServer.close(() => { resolve(); });
      }),
  };
}
