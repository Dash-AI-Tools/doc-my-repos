---
type: Reference
title: HTTP API
description: The five API routes. Parameters, authentication, response bodies and every status code for sync, webhooks, search, status and the image proxy.
tags: [reference, api]
status: stable
sources:
  - src/app/api/sync/route.ts
  - src/server/sync/manual-sync.ts
  - src/server/webhooks/endpoint.ts
  - src/server/search-api.ts
  - src/lib/palette.ts
  - src/server/status-api.ts
  - src/server/assets/serve.ts
generated: 2026-10-10
verified: 2026-10-10
stale_after: 2999-01-01
---

# HTTP API

The portal pages are server-rendered and have no public JSON contract. Five routes are meant to be called by other programs.

| Route                                  | Methods       | Authentication                        | Purpose                      |
| -------------------------------------- | ------------- | ------------------------------------- | ---------------------------- |
| `POST /api/sync`                       | `POST`        | `Authorization: Bearer <SYNC_SECRET>` | Start a sync                 |
| `POST /api/webhooks/github`            | `POST`        | `X-Hub-Signature-256` HMAC            | Receive GitHub App events    |
| `GET /api/search`                      | `GET`         | session cookie                        | Live results for the palette |
| `GET /api/status`                      | `GET`         | session cookie                        | Sync status                  |
| `GET /api/health`                      | `GET`         | none                                  | Health check, verdict only   |
| `GET /api/asset/{owner}/{repo}/{path}` | `GET`, `HEAD` | session cookie                        | Repository images            |

Every other method on a route answers `405` with an `Allow` header, without reading the request. Responses of the JSON routes carry `Cache-Control: no-store`. Put a rate limit in front of `/api/search`, `/api/sync` and `/api/status`: the app only caps how much work runs at once.

## POST /api/sync

Starts a manual sync. The secret is checked before the body is read or anything else is touched. The body is optional JSON of at most 4096 bytes.

| Body                      | Effect                                  |
| ------------------------- | --------------------------------------- |
| empty, or `{}`            | Full sync of every selected repository. |
| `{"repo": "name"}`        | Sync one repository by name.            |
| `{"repo": "owner/name"}`  | Sync one repository by owner and name.  |
| `{"githubId": 123456789}` | Sync one repository by GitHub id.       |

Unknown keys, and `repo` together with `githubId`, are rejected.

```bash
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" http://127.0.0.1:3000/api/sync
curl -X POST -H "Authorization: Bearer $SYNC_SECRET" -d '{"repo":"handbook"}' http://127.0.0.1:3000/api/sync
```

A successful answer lists one entry per repository:

```json
{
  "ok": true,
  "scope": "all",
  "run": { "id": 42, "status": "success", "durationMs": 812, "stats": { "reposTotal": 1 } },
  "repositories": [
    {
      "repo": "acme/handbook",
      "githubId": 101,
      "status": "ok",
      "error": null,
      "errorKind": null,
      "retryable": false,
      "retryAfter": null,
      "added": 2,
      "updated": 0,
      "identical": 0,
      "removed": 0,
      "skipped": 0,
      "failedFilesTotal": 0,
      "warningsTotal": 0
    }
  ]
}
```

`run.stats` is shortened here; it also holds the repository and document counters (`reposOk`, `reposFailed`, `docsAdded`, `docsRemoved` and others).

| Status | Meaning                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | The run finished with status `success` or `partial`.                                                                                            |
| `202`  | Coalesced: another sync holds the repository, the request is recorded and that sync runs again to include it. Body has `"status": "coalesced"`. |
| `400`  | `invalid_request`: the body is not valid JSON or not one of the shapes above.                                                                   |
| `401`  | `unauthorized`: missing or wrong secret. Carries `WWW-Authenticate: Bearer`.                                                                    |
| `404`  | `repository_not_found` (the App cannot see it) or `repository_not_configured` (excluded, archived or not listed; with a `reason`).              |
| `405`  | Not `POST`. `Allow: POST`.                                                                                                                      |
| `409`  | `repository_busy`: the repository has never been synced and its first sync is running elsewhere. Nothing was done, retry shortly.               |
| `413`  | `payload_too_large`: body over 4096 bytes.                                                                                                      |
| `500`  | `misconfigured` (the sync secret is missing, shorter than 16 characters, or the config is invalid) or `internal_error`.                         |
| `502`  | The run failed and a retry will not help by itself, for example rejected credentials.                                                           |
| `503`  | The run failed or could not start, and a retry may work. `Retry-After` is set when the retry time is known.                                     |

Only `Authorization: Bearer` is accepted, not a query string or a body field. The app has no brute-force counter. For the semantics of a run, see the [sync engine](../architecture/sync-engine.md).

## POST /api/webhooks/github

The endpoint of the GitHub App webhook. The request must be `application/json` with a valid `X-Hub-Signature-256`. The event name comes from `X-GitHub-Event`. Which events do what is described in [Webhooks](../guides/webhooks.md).

| Status | Meaning                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | `ping`. Body `{"ok":true,"event":"ping"}`.                                                                                                                      |
| `202`  | Accepted: dispatched, or still running after 5 seconds and left to finish in the background. Body `{"ok":true}`.                                                |
| `400`  | `invalid_request`: bad `X-GitHub-Event` or `X-GitHub-Delivery` header, or the body is not a JSON object. Only after the signature passed.                       |
| `401`  | `unauthorized`: signature missing, malformed or wrong. The same fixed answer in every case.                                                                     |
| `405`  | Not `POST`. `Allow: POST`.                                                                                                                                      |
| `413`  | `payload_too_large`: body over 25 MiB.                                                                                                                          |
| `415`  | `unsupported_media_type`: not `application/json`. Form-encoded deliveries are refused.                                                                          |
| `500`  | `misconfigured` (the webhook secret is missing or shorter than 16 characters) or `internal_error` (the router failed within the wait, so GitHub can redeliver). |

## GET /api/search

Live results for the command palette. Reads Postgres only, through the visibility filter.

| Parameter | Meaning                                                                        |
| --------- | ------------------------------------------------------------------------------ |
| `q`       | The query, in [web search syntax](../guides/search.md). Cut to 256 characters. |
| `limit`   | 1 to 10, default 8.                                                            |
| `repo`    | `owner/name`, repeatable. Narrows the results.                                 |

Type, tag, status and paging parameters are ignored here; use the `/search` page for those. An empty `q` answers at once with no hits and does not touch the database.

```json
{
  "q": "sync engine",
  "total": 1,
  "hits": [
    {
      "key": "12:docs/architecture/sync-engine.md",
      "title": "Sync engine",
      "href": "/acme/doc-my-repos/docs/architecture/sync-engine",
      "repoLabel": "acme/doc-my-repos",
      "path": "docs/architecture/sync-engine.md",
      "section": null,
      "snippet": "How a repository is copied into Postgres.",
      "isPrivate": false
    }
  ],
  "seeAll": "/search?q=sync%20engine"
}
```

A `snippet` is plain text. Matched words are wrapped in two private-use characters, U+E000 before and U+E001 after, which a client turns into highlights. Never insert a snippet as HTML.

| Status | Meaning                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | Results, possibly empty.                                                                                                                         |
| `405`  | Not `GET` (`HEAD` included). `Allow: GET`.                                                                                                       |
| `503`  | `{"error":"unavailable"}`: the database or configuration is unusable, or more than 16 searches are already running (then with `Retry-After: 1`). |

## GET /api/status

The sync status as JSON, for operators, scripts and health checks. It shows what the portal pages already show, through the same visibility filter, and nothing else: no secrets, run ids, SHAs or error stacks. Query parameters are ignored.

```json
{
  "generatedAt": "2026-10-10T12:00:00.000Z",
  "running": null,
  "lastRun": {
    "trigger": "webhook",
    "scope": "acme/handbook",
    "status": "success",
    "startedAt": "2026-10-10T11:59:59.000Z",
    "finishedAt": "2026-10-10T12:00:00.000Z",
    "durationMs": 812,
    "error": null,
    "counts": { "repos": 1, "ok": 1, "failed": 0, "docsAdded": 2 }
  },
  "summary": { "repos": 1, "ok": 1, "error": 0, "pending": 0, "withWarnings": 0 },
  "repos": [
    {
      "owner": "acme",
      "name": "handbook",
      "visibility": "private",
      "syncStatus": "ok",
      "syncError": null,
      "lastSyncedAt": "2026-10-10T12:00:00.000Z",
      "warnings": [],
      "skippedFiles": 0
    }
  ],
  "truncated": false
}
```

`lastRun.counts` is shortened here. `repos` lists at most 500 repositories by owner then name, and `truncated` is true when there are more; `summary` always counts all of them.

| Status | Meaning                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `200`  | The app and its database answer. A failed repository sync does **not** change this: read `summary.error` or `lastRun.status`.                    |
| `405`  | Not `GET` (`HEAD` included). `Allow: GET`.                                                                                                       |
| `503`  | `{"error":"unavailable"}`: the database or the configuration is unusable, or more than 4 reads are already running (then with `Retry-After: 1`). |

Use `GET` for container and load balancer health checks. The Docker image's `HEALTHCHECK` calls this route.

## GET /api/asset/{owner}/{repo}/{path}

The image proxy, and the only route that reads GitHub while serving a request. Rendered documents point their repository images here, so images of private repositories load without a credential reaching the browser. `{path}` is the repository-relative file path; the proxy always serves the default branch.

Allowed extensions: `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `ico`, `svg`. The bytes must match the type the extension claims.

| Status | Meaning                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------ |
| `200`  | The image, with `Content-Type` set from the verified type.                                       |
| `304`  | `If-None-Match` matched the strong `ETag`.                                                       |
| `400`  | The path is invalid: traversal, empty or dot-only segments, encoded slashes, too long.           |
| `404`  | Unknown, not visible or no longer selected repository, or no such file. The same answer for all. |
| `405`  | Not `GET` or `HEAD`. `Allow: GET, HEAD`.                                                         |
| `413`  | The image is larger than 10 MiB.                                                                 |
| `415`  | The extension is not an image type, or the bytes do not match it.                                |
| `500`  | The asset service is not available (configuration).                                              |
| `502`  | GitHub could not deliver the file.                                                               |
| `503`  | GitHub rate-limited the request, or the proxy is saturated. `Retry-After` is set.                |
| `504`  | Fetching took longer than 15 seconds.                                                            |

Caching: public repositories get `Cache-Control: public, max-age=300, stale-while-revalidate=600`, private ones `private, max-age=300`, so no shared cache stores a private image. Errors are `no-store`. A bounded in-memory cache (32 MiB, five minutes) spares GitHub; at most 6 upstream fetches run at once with 50 more queued, and concurrent requests for the same image share one fetch. Every response carries `X-Content-Type-Options: nosniff`, `Cross-Origin-Resource-Policy: same-origin`, `Referrer-Policy: no-referrer` and a sandboxing `Content-Security-Policy`. The reasoning is in the [security model](../architecture/security.md#image-proxy).
