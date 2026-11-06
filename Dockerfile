# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /app
RUN npm install -g pnpm@11.5.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/cli/package.json packages/cli/
COPY packages/client/package.json packages/client/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile
COPY . .
ARG GIT_COMMIT
RUN pnpm --filter web build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
	PORT=3000
WORKDIR /app
COPY --from=build /app/apps/web/package.json ./
COPY --from=build /app/apps/web/build ./build
COPY --from=build /app/apps/web/drizzle ./drizzle
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
	CMD wget -qO- http://127.0.0.1:3000/api/health > /dev/null || exit 1
CMD ["node", "build"]
