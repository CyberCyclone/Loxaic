// Imported FIRST by the e2e test so provider.ts sees MOCK_INFERENCE=true when
// it evaluates MOCK_MODE at module load. ESM executes imports in order, so
// this side effect must precede any import that transitively pulls provider.
process.env.MOCK_INFERENCE = "true";
process.env.MCP_ENCRYPTION_KEY ??= "e2e-test-key";
