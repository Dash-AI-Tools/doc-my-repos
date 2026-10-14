# syntax=docker/dockerfile:1

# DocMyRepos container image (task 13.1).
#
#   docker build -t docmyrepos .
#   docker run --rm --init -p 3000:3000 --env-file .env \
#     -e DATABASE_URL=postgres://user:pass@host:5432/db docmyrepos
#
# Three stages: `deps` installs the locked dependencies, `build` makes the Next.js standalone
# server and the migration bundle, `runtime` holds only what runs. The image contains no secrets
# and no config: the GitHub App settings come from environment variables, the optional
# docmyrepos.config.yml is mounted at /app/docmyrepos.config.yml (or named by CONFIG_PATH).
# On start the entrypoint applies the database migrations, then starts the server (see
# docker-entrypoint.sh). Node and pnpm are plain JavaScript here, so Alpine (musl) is fine.

ARG NODE_VERSION=24
ARG PNPM_VERSION=11.25.0

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS base
ARG PNPM_VERSION
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate
WORKDIR /app

# ---------------------------------------------------------------------------------------------
# Locked dependencies only. Re-runs when the manifests change, not on every source edit.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=docmyrepos-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ---------------------------------------------------------------------------------------------
# Next.js standalone server plus the self-contained migration bundle (dist/db-migrate.mjs).
# No database or GitHub App settings are needed to build: pages render per request.
FROM deps AS build
COPY . .
ENV NEXT_OUTPUT=standalone
RUN pnpm build && pnpm build:migrate \
    # The file tracer copies src/server/config (with its tests) because the config loader reads
    # files from the working directory. The server runs from the compiled build, not from src.
    && rm -rf .next/standalone/src

# ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="DocMyRepos" \
      org.opencontainers.image.description="Searchable documentation portal for the docs/ folders of a GitHub organization" \
      org.opencontainers.image.source="https://github.com/Dash-AI-Tools/doc-my-repos" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"

# HOSTNAME=0.0.0.0 makes the server listen on every interface (it would answer on the container's
# own address only otherwise), so the published port works. Never set E2E_FIXTURES here: it turns
# the app into a database-less fixture server.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

WORKDIR /app

# Files are owned by root and read-only to the app; the server only writes under /tmp and
# .next/cache (both can be tmpfs). The built-in `node` user (uid 1000) runs the process.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/dist/db-migrate.mjs ./dist/db-migrate.mjs
COPY drizzle ./drizzle
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod 0555 docker-entrypoint.sh && mkdir -p .next/cache && chown node:node .next/cache

# MIGRATIONS_DIR points at the copied drizzle/ folder; DB_WAIT_SECONDS bounds how long the
# entrypoint waits for the database before it gives up (see docker-entrypoint.sh).
ENV MIGRATIONS_DIR=/app/drizzle \
    DB_WAIT_SECONDS=60

USER node
EXPOSE 3000

# 200 means the app and its database answer; 503 means they do not (or the configuration is
# invalid). Node does the request because the image has no curl. The start period covers the
# migrations and the wait for a database that is still starting.
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Node does not need an init process (Next handles SIGTERM), but `docker run --init` or compose
# `init: true` reaps zombies and is recommended.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
