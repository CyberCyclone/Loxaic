/**
 * Streamable-HTTP variant of the mock MCP fixture, for exercising the http
 * transport path (including the allowPrivateNetwork override, since it binds
 * to localhost). Run with:
 *   pnpm exec tsx test-fixtures/mock-mcp-http-server.ts   # listens on :4009/mcp
 */
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = Number(process.env.MOCK_MCP_HTTP_PORT ?? 4009);

function buildServer(): McpServer {
  const server = new McpServer({ name: "mock-mcp-http", version: "1.0.0" });
  server.registerTool(
    "ping",
    { description: "Returns pong plus the given text.", inputSchema: { text: z.string().optional() } },
    async ({ text }) => ({ content: [{ type: "text", text: `pong${text ? `: ${text}` : ""}` }] }),
  );
  return server;
}

const httpServer = createServer(async (req, res) => {
  if (!req.url?.startsWith("/mcp")) {
    res.writeHead(404).end();
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
});

httpServer.listen(PORT, () => {
  console.log(`mock-mcp-http listening on http://localhost:${PORT}/mcp`);
});
