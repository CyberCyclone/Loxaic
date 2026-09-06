// Imported FIRST by prompt-prefix.test.ts, same seam as
// mcp/__tests__/force-mock-inference.ts: both values are read when their
// modules evaluate, so the side effect has to precede any import that pulls
// them in.
//
// AUTO_COMPACT_THRESHOLD is pinned to 0 (disabled) rather than left to the
// default, and that is not incidental. Compaction *legitimately* replaces the
// replayed history with a summary, which is the one sanctioned way for a
// prompt to stop extending the previous one — so a conversation that compacted
// mid-test would fail the prefix assertion for a reason that is not a bug. It
// is also set explicitly rather than relied upon: vitest gives each file a
// fresh module graph but shares the worker's process.env, so a sibling file
// that lowers the threshold could otherwise arm compaction here depending on
// which ran first.
process.env.MOCK_INFERENCE = "true";
process.env.AUTO_COMPACT_THRESHOLD = "0";
