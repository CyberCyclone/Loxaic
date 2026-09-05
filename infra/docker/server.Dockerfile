# Builds the server AND the web app it serves same-origin (apps/mobile's
# `export:web` output) — this replaces the old separate nginx `web` service,
# which duplicated a role the server has handled since the same-origin
# hosting work landed.
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
# pnpm workspaces validate the lockfile against every member's package.json,
# not just the ones a given image happens to need — a hand-picked subset of
# COPYs before `install` (the usual Docker layer-caching trick) leaves pnpm
# unable to resolve devDependencies transitively required by tools like
# Metro/babel-preset-expo. Copy the whole repo (.dockerignore keeps
# node_modules/dist/.git etc. out) and take the correctness over the
# cache-layer optimization.
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @loxaic/server build
RUN pnpm --filter @loxaic/mobile export:web

FROM node:22-alpine
WORKDIR /app
# The server build stays external for @loxaic/agent, @loxaic/db, and
# @loxaic/sync (tsup only inlines type-only packages), so those need to be
# present as real TS source at runtime — Node's built-in TypeScript support
# (unflagged since 22.18) loads them directly, no separate compile step.
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/server/package.json ./apps/server/package.json
COPY --from=builder /app/packages/db ./packages/db
COPY --from=builder /app/packages/agent ./packages/agent
COPY --from=builder /app/packages/sync ./packages/sync
COPY --from=builder /app/packages/types ./packages/types
# pnpm's node_modules is symlink-based, not flat: a package's deps resolve
# via a node_modules dir *next to it* (symlinked into the root .pnpm virtual
# store), not from the workspace root alone — so each package that has real
# runtime deps needs its own node_modules copied too, not just the root's.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=builder /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=builder /app/apps/mobile/dist ./web
ENV WEB_DIST_DIR=/app/web
EXPOSE 4000
# migrate.ts resolves migrationsFolder ("../../packages/db/drizzle") relative
# to process.cwd(), which assumes the process runs from apps/server/ (true in
# dev under tsx) — so the container's cwd matches that here too, rather than
# staying at /app and needing every relative path in the app rewritten.
WORKDIR /app/apps/server
CMD ["node", "dist/index.js"]
