import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries, one process each: the server, and the local executor the
  // desktop app spawns on the user's own machine (src/executor/main.ts). The
  // executor is built from this package because it reuses the host sandbox
  // provider, but it is a separate program — it never imports the database,
  // settings, or the server entry, and executor/__tests__/isolation.test.ts
  // fails the build if that ever changes.
  entry: { index: "src/index.ts", executor: "src/executor/main.ts" },
  format: ["esm"],
  clean: true,
  // The packaged desktop build runs this output under Electron's Node
  // (ELECTRON_RUN_AS_NODE, Node 20 in Electron 33) — no >=22 features.
  target: "node20",
  // Workspace packages ship raw TS with no build step; bundle them so dist
  // runs on any Node without native TS support. Real npm deps stay external —
  // drizzle-orm/postgres must therefore be direct deps of this package so the
  // bundled output can resolve them as bare specifiers.
  noExternal: [/^@loxaic\//],
});
