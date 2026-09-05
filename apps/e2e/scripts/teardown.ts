/** Standalone teardown: `pnpm --filter @loxaic/e2e teardown`. */
import { teardown } from './standup.ts';

await teardown();
