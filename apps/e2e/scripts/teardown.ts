/** Standalone teardown: `pnpm --filter @shannon/e2e teardown`. */
import { teardown } from './standup.ts';

await teardown();
