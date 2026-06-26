# syntax=docker/dockerfile:1

FROM node:22-alpine AS build

# better-sqlite3 compiles from source on Alpine (musl); prebuilds are often glibc-only.
RUN apk add --no-cache python3 make g++ sqlite-dev \
  && corepack enable && corepack prepare pnpm@11.6.0 --activate

WORKDIR /app

ENV CI=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY efw/package.json ./efw/

RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src/

RUN pnpm build \
  && pnpm prune --prod

FROM node:22-alpine AS runtime

RUN apk add --no-cache sqlite-libs \
  && addgroup -S app && adduser -S app -G app

WORKDIR /app

ENV NODE_ENV=production \
  HOST=0.0.0.0 \
  RECORD_STORE_SQLITE_PATH=/app/data/bugfixagent.db

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

RUN mkdir -p /app/data && chown -R app:app /app

USER app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
