FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY packages/config-ts/package.json packages/config-ts/
COPY packages/config-style/package.json packages/config-style/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
COPY packages/api-client/package.json packages/api-client/
COPY packages/db/package.json packages/db/
COPY apps/server/package.json apps/server/
RUN pnpm install --frozen-lockfile || true
COPY packages/config-ts packages/config-ts
COPY packages/config-style packages/config-style
COPY packages/types packages/types
COPY packages/ui packages/ui
COPY packages/api-client packages/api-client
COPY packages/db packages/db
COPY apps/server apps/server
RUN pnpm --filter @shannon/server build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/apps/server/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY --from=builder /app/packages/types/dist ./packages/types/dist
EXPOSE 4000
CMD ["node", "dist/index.js"]
