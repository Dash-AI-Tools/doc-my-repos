---
type: Guide
title: GitHub App setup
description: Register a read-only GitHub App, subscribe it to the right events, configure the webhook and find the App id, private key and installation id. Registration (5a) was tested by hand on an organization; install, webhook and manifest flow are not yet tested.
tags: [guides, setup, github-app]
status: draft
sources:
  - src/server/webhooks/router.ts
  - src/server/config/env.ts
generated: 2026-10-14
---

# GitHub App setup

> **Partly tested.** The manual registration in section 5a was followed in the GitHub web UI on a real organization (2026-10-14) and the steps below reflect what GitHub showed. The manifest flow (5b), the install, the webhook and the tunnel were not tested yet. See [Verification still required by a human](#verification-still-required-by-a-human) at the end.

## Before you start

- You need to be an **owner** of the organization (or the account owner, for a personal account). Only owners can create an App under _Settings > Developer settings_.
- GitHub asks you to confirm access (_sudo mode_) with your passkey, GitHub Mobile or password the first time you open the new-App form. Do this yourself; nobody else can do it for you.
- Decide how GitHub will reach the portal. You can register the App before you have a public URL: leave the webhook inactive and turn it on later (section 5a, step 4).

## 1. What the App is for

DocMyRepos reads the `docs/` folders of your repositories through a GitHub App installation. The App:

- lists the repositories it was installed on, and reads their file trees and file contents;
- sends webhooks to DocMyRepos when a repository changes or when the installation changes.

The App is read-only. It cannot write to a repository, open issues or change settings. DocMyRepos never uses a personal access token: a token is tied to one person, expires, and cannot send installation events.

DocMyRepos supports one installation of one App.

## 2. Permissions

Under **Repository permissions**, set exactly:

| Permission | Access    | Why                                                                                                                               |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Contents   | Read-only | Read the git tree and the blobs (docs, README, CODEOWNERS, images served by `/api/asset`). Needed by `push`.                      |
| Metadata   | Read-only | Mandatory for every App. Lists repositories and their name, visibility, default branch and archived flag. Needed by `repository`. |

Set no other repository permission, no organization permission and no account permission. If you add more later, GitHub asks each installation owner to accept them, and DocMyRepos does not need them.

## 3. Subscribed events

DocMyRepos handles these events and nothing else:

| Event                       | What DocMyRepos does                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `push`                      | Syncs the repository when the push is to its default branch (and does not delete the branch).                                                                                                   |
| `repository`                | `deleted` and `archived` remove the stored repository. `privatized` marks it private at once, then syncs. `renamed`, `created`, `edited`, `transferred`, `publicized` and `unarchived` sync it. |
| `installation_repositories` | `added` syncs the added repositories (a full sync if there are many). `removed` removes them.                                                                                                   |
| `installation`              | `deleted` and `suspend` mark every repository as errored and keep the stored content. `unsuspend`, `created` and `new_permissions_accepted` start a full sync.                                  |

In GitHub's App settings, the _Subscribe to events_ checkboxes appear only for events your permissions allow. `push` appears once Contents is set. `repository` appears once Metadata is set. As far as the GitHub documentation indicates, `installation` and `installation_repositories` are sent to every App without a checkbox. This was not confirmed by registering an App; see the checklist.

`ping` (sent when the App is created or when you press _Redeliver_ on a ping) is answered with 200 and does nothing. Any other event, any unknown action, and any payload for another installation id are accepted with a 202 and ignored. Pushes to other branches and events for repositories outside `repos`/`exclude` in `docmyrepos.config.yml` are ignored too.

## 4. Webhook

| Setting          | Value                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| Webhook URL      | `https://<your-host>/api/webhooks/github`                                     |
| Content type     | `application/json`                                                            |
| Secret           | A random string of 16 or more characters. For example `openssl rand -hex 32`. |
| SSL verification | Enabled                                                                       |
| Active           | Yes                                                                           |

Details taken from the endpoint:

- The signature (`X-Hub-Signature-256`) is verified over the raw body with `GITHUB_WEBHOOK_SECRET`. A missing or wrong signature gets a fixed 401.
- `application/x-www-form-urlencoded` is refused with 415. Choose `application/json`.
- Bodies over 25 MiB get 413.
- If `GITHUB_WEBHOOK_SECRET` is missing or shorter than 16 characters, every delivery gets 500.
- A good delivery gets 202 (200 for `ping`). A sync is started in the background and is not waited for beyond about 5 seconds.

## 5. Registering the App

There are two ways. Both end with the same App.

### 5a. Manual registration

1. Open `https://github.com/organizations/<ORG>/settings/apps/new` (or _Settings > Developer settings > GitHub Apps > New GitHub App_). For a personal account use _Settings > Developer settings_ of that account. Confirm access if GitHub asks (see _Before you start_).
2. Fill in the name (must be unique on GitHub; the App's URL slug is the lowercased name with spaces turned into dashes, for example `DocMyRepos My-Org` becomes `docmyrepos-my-org`) and a homepage URL (any URL, for example your portal's or the repository's). The description is optional.
3. Leave the _Redirect URI_ row empty. Leave _Request user authorization (OAuth) during installation_ and _Enable Device Flow_ unticked. _Expire user authorization tokens_ is ticked by default; it does nothing here because DocMyRepos does not use user login, so leaving it ticked is fine. Leave _Setup URL_ and _Redirect on update_ empty.
4. Under **Webhook**:
   - **You have a public URL or tunnel:** keep _Active_ ticked, enter the webhook URL and paste the webhook secret from section 4. Keep SSL verification enabled.
   - **You do not have one yet:** untick _Active_. The _Webhook URL_ field then stops being required, and you can create the App with it empty. Come back to _App settings > General > Webhook_ later, tick _Active_ and fill in the URL and secret. Until then there are no push-triggered syncs; use the manual sync in section 8.
5. Open **Repository permissions**, set **Contents** to _Read-only_, and leave everything else at _No access_. **Metadata** is already _Read-only_ and cannot be changed (it is marked _Mandatory_). Leave _Organization permissions_ and _Account permissions_ alone.
6. Under **Subscribe to events**, tick `push` and `repository`. The checkboxes show up only after the matching permission is set (section 3).
7. Under _Where can this GitHub App be installed?_ choose **Only on this account**.
8. Press **Create GitHub App**. GitHub opens the App's settings page with the banner _"You must generate a private key in order to install your GitHub App."_ Continue with section 6, and generate the private key **before** you install.

### 5b. Manifest flow

GitHub can create the App from a JSON manifest. The manifest is in [`github-app-manifest.json`](./github-app-manifest.json). Replace `https://docs.example.com` with your host in both URLs before use.

```json
{
  "name": "DocMyRepos (your org)",
  "url": "https://docs.example.com",
  "hook_attributes": {
    "url": "https://docs.example.com/api/webhooks/github",
    "active": true
  },
  "redirect_url": "https://docs.example.com/",
  "public": false,
  "default_permissions": {
    "contents": "read",
    "metadata": "read"
  },
  "default_events": ["push", "repository"]
}
```

How the manifest flow works, per GitHub's documentation:

1. You send the manifest in a form field named `manifest` with an HTML form that POSTs to `https://github.com/settings/apps/new` (personal account) or `https://github.com/organizations/<ORG>/settings/apps/new` (organization). A short local HTML file with one hidden input and a submit button is enough. You can add `?state=<random string>` to the URL.
2. GitHub shows the App for confirmation. When you confirm, GitHub redirects the browser to `redirect_url` with `?code=<temporary code>` (and your `state`). `redirect_url` must be reachable by your browser, but nothing has to be listening: you only need to copy the `code` from the address bar.
3. Within one hour, exchange the code with `POST https://api.github.com/app-manifests/<code>/conversions` (no authentication needed). The response contains the App `id`, the private key `pem`, and a generated `webhook_secret`. Save the `pem` to a file, and use the `webhook_secret` as `GITHUB_WEBHOOK_SECRET` (it is at least 16 characters; check this).

What the manifest leaves to you or to GitHub, stated honestly:

- `default_events` lists `push` and `repository` only. Whether `installation` and `installation_repositories` are valid values there, or are delivered anyway, was not verified. They are left out on purpose; if the App does not receive them after installation, add them in the App's settings if the checkboxes exist.
- `public: false` means the App can be installed only on the owning account.
- Not verified: whether GitHub requires further fields (such as `request_oauth_on_install` or `setup_on_update`) when the manifest has no callback URL. Expect to adjust if GitHub rejects the manifest and report what it says.
- The manifest flow does not install the App. Continue with section 6.

## 6. App id, private key and installation id

1. **App id.** On the App's settings page (_Settings > Developer settings > GitHub Apps > your App_), under **About**, copy **App ID**, a number. This is `GITHUB_APP_ID`. The page also shows a **Client ID** (starts with `Iv`); it is not the App ID, do not use it for `GITHUB_APP_ID`.
2. **Private key.** GitHub will not let you install the App until it has a private key, so do this first. On the same page, open **Private keys** (the _Credentials_ tab in the current UI, or the bottom of _General_) and press _Generate a private key_. GitHub downloads a `.pem` file once. Store it somewhere private. GitHub issues an unencrypted RSA key in PKCS#1 form (`-----BEGIN RSA PRIVATE KEY-----`). DocMyRepos also accepts an unencrypted PKCS#8 RSA key (`-----BEGIN PRIVATE KEY-----`). Encrypted keys and non-RSA keys are rejected.
3. **Install.** Open the App's **Install App** tab, choose your organization, and select **All repositories** or **Only select repositories**. To import every repository of the organization now and in the future, choose **All repositories**. GitHub shows the permissions the App will get ("Read access to code and metadata") before you press **Install**. You can open the page directly at `https://github.com/apps/<app-slug>/installations/new`.
4. **Installation id.** After installing, you land on a URL like `https://github.com/organizations/<ORG>/settings/installations/<id>` (for a personal account, `https://github.com/settings/installations/<id>`). The number at the end is `GITHUB_APP_INSTALLATION_ID`. You can also find it later under the organization's _Settings > GitHub Apps > Configure_, in the same URL. Through the API, authenticate as the App with a JWT and call `GET /app/installations`; the `id` field of the entry for your organization is the installation id.

### Which repositories are synced

The App's installation selection is the upper bound. DocMyRepos discovers repositories from the installation's accessible repositories, so a repository the App cannot see is never synced, whatever the config says.

`docmyrepos.config.yml` only narrows that set:

- no `repos` and no `exclude`: every repository the installation can access (the repository's sample `docmyrepos.config.yml` used to list three demo repositories; check yours does not narrow the set by accident);
- `repos`: only those names (they must be accessible to the App);
- `exclude`: every accessible repository except those.

A private repository that is missing from the portal usually means it is not in the installation's selection. Add it under _Settings > GitHub Apps > Configure > Repository access_; GitHub then sends `installation_repositories`.

Remember that the portal has no login in the MVP: anyone who can reach it can read everything the App can read. Install the App only on repositories you want shown.

## 7. Environment variables

Set these in `.env` for local development, or in your deployment's environment. The names are the ones read by `src/server/config/env.ts`.

| Variable                      | Value                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `GITHUB_APP_ID`               | The numeric App ID.                                                                              |
| `GITHUB_APP_INSTALLATION_ID`  | The numeric installation id.                                                                     |
| `GITHUB_APP_PRIVATE_KEY_PATH` | Path to the `.pem` file. Preferred.                                                              |
| `GITHUB_APP_PRIVATE_KEY`      | The PEM text inline, as an alternative. Set exactly one of the two; setting both is an error.    |
| `GITHUB_WEBHOOK_SECRET`       | The webhook secret from section 4. At least 16 characters.                                       |
| `SYNC_SECRET`                 | Secret that guards `POST /api/sync`. At least 16 characters. For example `openssl rand -hex 32`. |

The IDs must be positive integers. Values are trimmed, and empty values count as unset.

### Providing the private key

- Prefer `GITHUB_APP_PRIVATE_KEY_PATH`. The file is read at startup. The variable must hold a path; if its value looks like key content, the app refuses it and tells you to use `GITHUB_APP_PRIVATE_KEY`.
- Inline (`GITHUB_APP_PRIVATE_KEY`) accepts the PEM with real newlines, or on one line with literal `\n` escapes (`\r\n` too). Keep the `-----BEGIN ...-----` and `-----END ...-----` lines.
- Never commit the key or `.env`. Keep both out of images and logs.
- In Docker, mount the key as a read-only file or secret (for example `-v /secure/app.pem:/run/secrets/app.pem:ro`) and set `GITHUB_APP_PRIVATE_KEY_PATH=/run/secrets/app.pem`.
- Set restrictive permissions on the file (`chmod 600`).

### Rotating

- **Private key.** Generate a second key on the App's settings page, switch `GITHUB_APP_PRIVATE_KEY_PATH` (or the inline value) to it, restart DocMyRepos, check that a manual sync works, then delete the old key on GitHub.
- **Webhook secret.** The new value must be set in two places that cannot change at the same instant: the App settings and `GITHUB_WEBHOOK_SECRET`. Deliveries sent between the two changes fail with 401. Change both, restart, and redeliver any failed deliveries from _Advanced > Recent Deliveries_.
- **Sync secret.** Change `SYNC_SECRET` and update every cron job or script that calls `/api/sync`.

## 8. Local development

GitHub must be able to reach your machine to deliver webhooks. Use a tunnel to the dev server (port 3000 with `pnpm dev`):

- **smee.io.** Create a channel at <https://smee.io>, then run `npx smee-client --url https://smee.io/<channel> --target http://localhost:3000/api/webhooks/github`. Use the smee URL as the webhook URL. smee forwards the body and signature headers unchanged.
- **ngrok.** `ngrok http 3000`, then use `https://<id>.ngrok-free.app/api/webhooks/github`.
- **cloudflared.** `cloudflared tunnel --url http://localhost:3000`, then use the printed `https://<name>.trycloudflare.com/api/webhooks/github`.

Next.js reads `.env` only when `pnpm dev` starts. After you change `GITHUB_WEBHOOK_SECRET`, `SYNC_SECRET` or any App variable, stop the dev server and start it again; a server started earlier keeps the old values and answers 401. `pnpm dev` also picks port 3001 when 3000 is taken, which breaks a tunnel pointed at 3000, so make sure only one dev server is running.

Set the App's webhook URL (_App settings > General > Webhook URL_) to the tunnel URL. Free tunnel URLs change on restart, so update it each time. Switch it back to the real host afterwards.

Use _App settings > Advanced > Recent Deliveries_ to see each delivery's request, response and status code, and press _Redeliver_ to send it again. Redelivery is safe: processing is idempotent.

### Manual sync

`POST /api/sync` accepts `Authorization: Bearer <SYNC_SECRET>` only (not a query string or a body field).

```bash
# all repositories
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" http://localhost:3000/api/sync

# one repository, by name, owner/name or GitHub id
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" -d '{"repo":"handbook"}' http://localhost:3000/api/sync
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" -d '{"repo":"my-org/handbook"}' http://localhost:3000/api/sync
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" -d '{"githubId":123456789}' http://localhost:3000/api/sync
```

Answers: 200 finished, 202 another sync is running and will rerun to cover this request, 401 wrong or missing secret, 404 unknown or unselected repository, 409 first sync of a repository is running elsewhere (retry), 502/503 the run failed (503 may carry `Retry-After`).

## 9. Verifying it works

1. **Ping.** After saving the App, open _Advanced > Recent Deliveries_ and find the `ping` delivery (or redeliver it). Expected response: 200.
2. **Manual sync.** Run the first `curl` above. Expect a 200 and a `repositories` list.
3. **Repository appears.** Open the portal. Repositories with docs show up with their documents.
4. **Push.** Push a change to a Markdown file in `docs/` on a repository's default branch. The delivery should show 202. A new row appears in the `sync_runs` table (`trigger = 'webhook'`), and the change shows in the portal.

### Troubleshooting

| Symptom                                                                           | Likely cause and fix                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook delivery gets 401                                                         | `GITHUB_WEBHOOK_SECRET` differs from the App's secret, or a proxy changed the body (re-encoding, compression). Forward the raw body untouched.                                                                                                                                                 |
| Delivery gets 415                                                                 | The App's content type is `application/x-www-form-urlencoded`. Change it to `application/json`.                                                                                                                                                                                                |
| Delivery gets 500                                                                 | `GITHUB_WEBHOOK_SECRET` is unset or shorter than 16 characters, or dispatching failed. Check the server log.                                                                                                                                                                                   |
| Delivery or `/api/sync` gets 401 with body `{"error":"Unauthorized"}` (capital U) | That body comes from the login gate in `src/proxy.ts`, not from the route (the route's own 401 is lowercase `{"error":"unauthorized"}`). `/api/sync` and `/api/webhooks/github` must be exempt from the session gate. If you see this, check that `isPublicPath` in `src/proxy.ts` lists both. |
| Delivery gets 202 but nothing syncs                                               | The event is ignored by design: another branch, a repository outside `repos`/`exclude`, another installation id, or an unhandled event. Check the log line.                                                                                                                                    |
| `/api/sync` returns 401                                                           | Wrong secret, or the header is not `Authorization: Bearer <secret>`.                                                                                                                                                                                                                           |
| `/api/sync` returns 500 `misconfigured`                                           | `SYNC_SECRET` is unset or shorter than 16 characters, or the config file is invalid.                                                                                                                                                                                                           |
| `/api/sync` returns 503                                                           | GitHub rate limit or a transient error. Wait for `Retry-After` and retry. Sync backs off automatically.                                                                                                                                                                                        |
| Repositories show "installation unavailable"                                      | The App was uninstalled or suspended (`installation` event `deleted`/`suspend`). Content is kept. Reinstall or unsuspend; an `unsuspend`/`created` event starts a full sync, or run a manual sync.                                                                                             |
| A private repository does not appear                                              | It is not in the installation's repository selection, or `repos`/`exclude` filters it out.                                                                                                                                                                                                     |
| Startup says the private key is invalid                                           | Wrong or truncated PEM, an encrypted key, or a non-RSA key. Use the `.pem` GitHub issued. With the inline variable, check the `\n` escapes.                                                                                                                                                    |
| Startup says the key file cannot be read (ENOENT, EACCES)                         | The path is wrong or the process cannot read the file. In Docker, check the mount.                                                                                                                                                                                                             |
| Startup says to set only one of the key variables                                 | Both `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_PRIVATE_KEY_PATH` are set. Unset one.                                                                                                                                                                                                            |

## Verification still required by a human

This guide has not been tested end to end. To finish task 6.5, a person with permission to create GitHub Apps on a test organization must:

- [x] Register a test App by following section 5a (done 2026-10-14 on an organization, with the webhook inactive). The steps were corrected from what GitHub showed.
- [ ] Register a test App by the manifest flow in section 5b. Note any field GitHub rejects and fix the manifest.
- [x] Confirm Contents (Read-only), Metadata (mandatory, Read-only), and the `push` and `repository` checkboxes match sections 2 and 3.
- [x] `installation` arrives without a checkbox: an `installation.created` delivery appeared in _Advanced > Recent Deliveries_ right after the install, with only `push` and `repository` ticked. Not checked yet: `installation_repositories`, and whether either is valid in `default_events`.
- [ ] Confirm the manifest conversion returns a webhook secret of at least 16 characters.
- [ ] Generate a private key and confirm DocMyRepos accepts it via `GITHUB_APP_PRIVATE_KEY_PATH` and via the inline variable.
- [x] Install the App on a test organization (done 2026-10-14 with _All repositories_; GitHub landed on `.../settings/installations/<id>` as described in section 6).
- [ ] Confirm the installation id from the URL matches `GET /app/installations`.
- [x] Run DocMyRepos through a tunnel (ngrok), and confirm the `ping` delivery succeeds. Done 2026-10-14: the first deliveries failed with 401 (secret not set yet and, at the time, the login gate in `src/proxy.ts` blocked the route); after fixing both, _Redeliver_ on the ping showed a green check.
- [ ] Push to a default branch, and confirm a `sync_runs` row with `trigger = 'webhook'` and updated content in the portal.
- [ ] Add and remove a repository in the installation selection, and confirm the portal follows.
- [x] Run the first `curl` example in section 8 against the running app (2026-10-14: 200, all repositories of the organization synced). The single-repository examples are not run yet.
- [ ] Rotate the private key and the webhook secret following section 7.
