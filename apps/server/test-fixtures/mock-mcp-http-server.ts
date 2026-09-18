/**
 * Runs the streamable-HTTP mock MCP server as a process — for the e2e harness,
 * which has no MCP SDK of its own, and for poking at by hand:
 *   pnpm exec tsx test-fixtures/mock-mcp-http-server.ts   # listens on :4009/mcp
 *
 * MOCK_MCP_HTTP_PORT picks the port; MOCK_MCP_HTTP_TOKEN, when set, refuses
 * every other bearer (see src/mcp/__tests__/mock-mcp-http.ts).
 */
import { startMockMcpHttp } from "../src/mcp/__tests__/mock-mcp-http.ts";

const mock = await startMockMcpHttp({
  port: Number(process.env.MOCK_MCP_HTTP_PORT ?? 4009),
  requireBearer: process.env.MOCK_MCP_HTTP_TOKEN || undefined,
});
console.log(`mock-mcp-http listening on ${mock.url}`);
