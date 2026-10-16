# create-docmyrepos

Installer for [DocMyRepos](https://github.com/Dash-AI-Tools/doc-my-repos): a self-hosted documentation portal that syncs the `docs/` folders of a GitHub organization's repositories.

```bash
npx create-docmyrepos            # asks a few questions
npx create-docmyrepos --help     # every option
```

It checks Docker, creates (or checks) a read-only GitHub App, generates the secrets, writes `docker-compose.yml`, `.env`, `docmyrepos.config.yml` and the App key into a new folder (owner-only permissions, never overwriting an installation), starts the stack and starts the first sync. The only network traffic goes to GitHub and, through Docker, to the container registry. There is no telemetry.

The package has no runtime dependencies and uses only Node.js built-ins (Node 20 or newer).

## Options

| Option                            | Meaning                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| `[folder]`, `--dir`               | Folder to install into (default `./docmyrepos`)                    |
| `--org`                           | GitHub organization                                                |
| `--url`                           | Address the portal is reached at (default `http://localhost:3000`) |
| `--port`                          | Host port, published on 127.0.0.1 only (default 3000)              |
| `--admin-email`                   | First admin's email                                                |
| `--repos all\|a,b,c`              | Repositories to include (default all)                              |
| `--app existing\|create`          | Use an existing GitHub App, or create one in the browser           |
| `--image-tag`                     | Image tag to pin (default: the installer's version)                |
| `-y`, `--yes`                     | Never prompt; every answer comes from options and environment      |
| `--dry-run`                       | Run the checks and print the plan; write, create and start nothing |
| `--no-start`                      | Write the files, do not pull or start                              |
| `--force`                         | Back up an existing installation's files and replace them          |
| `--no-browser`                    | Do not launch a browser; paste the App's code by hand              |
| `-h`, `--help`, `-v`, `--version` |                                                                    |

Secrets are never options. Use the environment: `DOCMYREPOS_ADMIN_PASSWORD`, `DOCMYREPOS_APP_ID`, `DOCMYREPOS_APP_KEY_FILE`, `DOCMYREPOS_INSTALLATION_ID`, `DOCMYREPOS_WEBHOOK_SECRET`.

Exit codes: 0 success, 1 failure (written files are kept), 2 usage error or missing answers, 130 interrupted.

A scripted install with an existing App:

```bash
DOCMYREPOS_APP_ID=123 DOCMYREPOS_APP_KEY_FILE=./key.pem DOCMYREPOS_WEBHOOK_SECRET=... \
  npx create-docmyrepos --yes --org acme --admin-email admin@acme.io --app existing
```
