import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['components/**/*.test.ts', 'lib/**/*.test.ts'],
  },
});
