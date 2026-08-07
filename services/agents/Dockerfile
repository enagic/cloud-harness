# One image, three entrypoints. The refiner, implementer, and reviewer share
# their clone/model/Jira machinery, so three images would be three copies of the
# same layers with three build pipelines to keep in step. The task definitions
# in infra/agents.tf select the agent via `command`.
#
# Build context is the REPO ROOT:
#   docker build -f services/agents/Dockerfile .

FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* tsconfig.base.json tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY services/agents/package.json services/agents/

RUN npm ci --workspaces --include-workspace-root

COPY packages/shared packages/shared
COPY services/agents services/agents

RUN npm run build --workspace @cloud-harness/agents
RUN npm prune --omit=dev --workspaces --include-workspace-root

FROM node:22-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# All three agents shell out to git. The implementer and reviewer additionally
# build and test whatever repo they land in — extend this as target repos demand.
RUN apk add --no-cache git openssh-client bash ca-certificates

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/services/agents/dist ./dist
COPY --from=build /app/services/agents/package.json ./package.json

# WORKSPACE_DIR in the task definitions. Owned by node so agents can clone into
# it without running as root.
RUN mkdir -p /workspace && chown -R node:node /workspace
USER node

# Overridden per task definition:
#   ["node", "dist/refiner/main.js"]
#   ["node", "dist/implementer/main.js"]
#   ["node", "dist/reviewer/main.js"]
CMD ["node", "dist/refiner/main.js"]
