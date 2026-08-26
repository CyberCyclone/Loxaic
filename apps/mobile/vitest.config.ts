import { defineConfig } from "vitest/config";

/** Unit tests for platform-independent client logic (lib/), not components —
 * anything importing react-native needs a native preset this app doesn't have. */
export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts"],
  },
});
