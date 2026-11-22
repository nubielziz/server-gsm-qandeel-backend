# Production image of the GSM backend (feature 24D, decision 036): one image runs the API (default), the worker
# (`bun src/worker.ts`) and the one-off tools (`bun scripts/db-migrate.ts`, `bun scripts/setup.ts`).
# Build:  docker build -t gsm-backend:<tag> --build-arg GIT_SHA=$(git rev-parse HEAD) --build-arg APP_VERSION=<version> .
# Bun must start from /app: it reads tsconfig.json there for the decorator flags NestJS needs (decision 001).

ARG BUN_IMAGE=oven/bun:1.4.4-slim

# Stage 1: production dependencies only. Lifecycle scripts stay off: nothing in `dependencies` needs one.
FROM ${BUN_IMAGE} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production --ignore-scripts

# Stage 2: the files the runtime reads, and nothing else (the .dockerignore keeps secrets, tests, docs and the map out).
FROM ${BUN_IMAGE} AS tree
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
COPY drizzle ./drizzle
# The one-off tools of a deploy: the migrator, the first-run flow, the search-key setup and the Telegram webhook registration (they import
# src/** and these files only), and the export that release 30 runs before its migration (it imports pg and Node built-ins only;
# docs/OPERATIONS.md, release 30).
COPY scripts/db-migrate.ts scripts/setup.ts scripts/first-run.ts scripts/search-keys.ts scripts/telegram-webhook.ts scripts/english-only-export.ts ./scripts/
COPY scripts/lib/first-run-flow.ts scripts/lib/first-admin-prompt.ts scripts/lib/stdin-password.ts scripts/lib/terminal-prompter.ts ./scripts/lib/

# Stage 3 (thrown away): proves no production code imports a development dependency. Importing the two root modules loads
# every module file; a missing package fails the build here instead of at the first boot. The config is not read at import.
FROM tree AS verify
ENV NODE_ENV=production
RUN bun -e "await import('./src/app.module.ts'); await import('./src/worker.module.ts'); for (const f of ['first-run', 'search-keys', 'telegram-webhook', 'english-only-export', 'lib/first-run-flow', 'lib/first-admin-prompt', 'lib/stdin-password', 'lib/terminal-prompter']) await import('./scripts/' + f + '.ts'); console.log('imports ok')" \
 && echo ok > /tmp/verified

# Stage 4: the runtime.
FROM tree AS runtime
ARG GIT_SHA=unknown
ARG APP_VERSION=0.0.0
ENV NODE_ENV=production \
    GIT_SHA=${GIT_SHA} \
    APP_VERSION=${APP_VERSION} \
    PORT=3000
# Copying the marker from `verify` makes BuildKit run that stage even though no layer of the image depends on it.
COPY --from=verify /tmp/verified /tmp/verified
USER bun
EXPOSE 3000 9464
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 3000}/health?strict=1`); process.exit(r.ok ? 0 : 1)"]
# Exec form: Bun is PID 1 (compose adds `init: true`) and receives SIGTERM, which starts the graceful shutdown.
CMD ["bun", "src/main.ts"]
