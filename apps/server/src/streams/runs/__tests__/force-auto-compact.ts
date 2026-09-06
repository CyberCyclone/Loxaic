// Imported FIRST by auto-compact-run.test.ts, for the same reason as
// mcp/__tests__/force-mock-inference.ts: both MOCK_INFERENCE and
// AUTO_COMPACT_THRESHOLD are read when their modules evaluate, so the side
// effect has to precede any import that transitively pulls them in.
//
// The threshold is dropped to a value the mock backend can actually cross —
// it reports a 4096-token window and ~15 tokens per turn, so the real 0.85
// would need a conversation no mock could produce. The test file restores it
// in afterAll: vitest gives each file a fresh module graph but shares the
// worker's process.env, so a leaked value would arm auto-compaction inside
// any later file that drives a run.
process.env.MOCK_INFERENCE = "true";
process.env.AUTO_COMPACT_THRESHOLD = "0.001";
