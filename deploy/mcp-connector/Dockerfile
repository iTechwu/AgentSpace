FROM node:25-alpine AS build

WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/mcp-connector/package.json apps/mcp-connector/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/mcp-connector apps/mcp-connector
COPY packages/domain packages/domain
RUN pnpm --filter @dofe-agent/mcp-connector run build

FROM node:25-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /workspace/apps/mcp-connector/dist ./dist
USER node
EXPOSE 8787
ENTRYPOINT ["node", "dist/index.js"]
