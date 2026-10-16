/**
 * The compose file the installer writes, derived from the repository's `docker-compose.yml`:
 * the same hardening, but the published image instead of `build:`, no published database port and
 * no default database password. `compose-template.test.ts` compares the two files so a change to
 * the hardening in the repository file cannot be missing here.
 *
 * Lines are kept as an array because the YAML is full of `${...}` that template literals would
 * interpolate. Lines starting with `#KEYFILE# ` belong to the "key as a compose secret" layout:
 * they are uncommented for it and dropped for the inline layout. `__VERSION__` is the image tag.
 */
export const KEYFILE_MARK = "#KEYFILE# ";
export const VERSION_TOKEN = "__VERSION__";

export const COMPOSE_TEMPLATE_LINES: readonly string[] = [
  "# DocMyRepos, written by create-docmyrepos " + VERSION_TOKEN + ".",
  "#",
  "#   docker compose up -d --wait",
  "#",
  "# Settings and secrets are in .env next to this file (keep it private, never commit it).",
  "# TLS belongs to a reverse proxy in front of the app. The app is published on 127.0.0.1 only;",
  "# change APP_BIND in .env only if the proxy runs on another host.",
  "# To upgrade, change DOCMYREPOS_VERSION in .env (or the tag below) and run `docker compose pull`.",
  "name: docmyrepos",
  "",
  "services:",
  "  db:",
  "    image: postgres:17",
  "    restart: unless-stopped",
  "    environment:",
  "      POSTGRES_USER: ${POSTGRES_USER:-docmyrepos}",
  "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set in .env}",
  "      POSTGRES_DB: ${POSTGRES_DB:-docmyrepos}",
  "    # The database port is not published: only the app reaches it, over the compose network.",
  "    volumes:",
  "      - db-data:/var/lib/postgresql/data",
  "    healthcheck:",
  '      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U $$POSTGRES_USER -d $$POSTGRES_DB"]',
  "      interval: 5s",
  "      timeout: 5s",
  "      retries: 10",
  "      start_period: 5s",
  "",
  "  app:",
  "    image: ghcr.io/dash-ai-tools/doc-my-repos:${DOCMYREPOS_VERSION:-" + VERSION_TOKEN + "}",
  "    env_file:",
  "      - .env",
  "    environment:",
  "      # Inside the compose network the database is the `db` service.",
  "      DATABASE_URL: postgres://${POSTGRES_USER:-docmyrepos}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB:-docmyrepos}",
  "    depends_on:",
  "      db:",
  "        condition: service_healthy",
  "    ports:",
  '      - "${APP_BIND:-127.0.0.1}:${APP_PORT:-3000}:3000"',
  "    volumes:",
  "      - ./docmyrepos.config.yml:/app/docmyrepos.config.yml:ro",
  KEYFILE_MARK +
    "    # The private key is a compose secret, mounted at /run/secrets/github_app_key.",
  KEYFILE_MARK + "    secrets:",
  KEYFILE_MARK + "      - github_app_key",
  "    healthcheck:",
  "      # The test comes from the image (GET /api/status: 200 when the app and the database answer).",
  "      interval: 10s",
  "    restart: unless-stopped",
  "    # Reaps zombie processes and forwards signals. SIGTERM stops the sync scheduler and the server.",
  "    init: true",
  "    stop_grace_period: 30s",
  "    # Immutable root file system; the server only writes to /tmp.",
  "    read_only: true",
  "    tmpfs:",
  "      - /tmp",
  "    security_opt:",
  "      - no-new-privileges:true",
  "    cap_drop:",
  "      - ALL",
  "    pids_limit: 512",
  "    logging:",
  "      driver: json-file",
  "      options:",
  '        max-size: "10m"',
  '        max-file: "3"',
  "",
  KEYFILE_MARK + "secrets:",
  KEYFILE_MARK + "  github_app_key:",
  KEYFILE_MARK + "    file: ./github-app.private-key.pem",
  "",
  "volumes:",
  "  db-data:",
];

/**
 * Renders the template for one layout and image tag. `tag` must already be validated
 * (`validateImageTag`); it is placed in the file as is.
 */
export function renderCompose(options: { tag: string; keyAsFile: boolean }): string {
  const lines: string[] = [];
  for (const line of COMPOSE_TEMPLATE_LINES) {
    if (line.startsWith(KEYFILE_MARK)) {
      if (options.keyAsFile) lines.push(line.slice(KEYFILE_MARK.length));
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n").replaceAll(VERSION_TOKEN, options.tag) + "\n";
}
