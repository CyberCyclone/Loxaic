import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The app's own `@/` path alias (tsconfig `paths`), which Metro resolves and
  // Vitest does not — without it any module importing through it is untestable.
  resolve: {
    alias: [{ find: /^@\//, replacement: `${ROOT}/` }],
  },
  test: {
    environment: 'node',
    include: ['components/**/*.test.ts', 'lib/**/*.test.ts'],
  },
});
