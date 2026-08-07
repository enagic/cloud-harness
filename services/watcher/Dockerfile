# Build context is the REPO ROOT, not this directory — the build needs the
# workspace root package.json and packages/shared.
#   docker build -f services/watcher/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY services/watcher/package.json services/watcher/

RUN npm ci --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY services/watcher services/watcher

RUN npm run build --workspace @cloud-harness/watcher
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/services/watcher/dist ./dist
COPY --from=build /app/services/watcher/package.json ./package.json

USER node

# infra/ecs.tf runs `node dist/healthcheck.js` as the container health check.
CMD ["node", "dist/index.js"]
