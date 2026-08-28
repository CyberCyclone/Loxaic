import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  clean: true,
  // The packaged desktop build runs this output under Electron's Node
  // (ELECTRON_RUN_AS_NODE, Node 20 in Electron 33) — no >=22 features.
  target: "node20",
  // Workspace packages ship raw TS with no build step; bundle them so dist
  // runs on any Node without native TS support. Real npm deps stay external —
  // drizzle-orm/postgres must therefore be direct deps of this package so the
  // bundled output can resolve them as bare specifiers.
  noExternal: [/^@shannon\//],
});
