---
type: Decision
title: Serialize syncs with advisory locks, no job queue
description: Syncs of one repository are serialized with a Postgres session-level advisory lock and a database rerun marker, instead of a queue service. The sync function stays queue-agnostic.
tags: [decisions, sync, database]
status: accepted
sources:
  - openspec/changes/archive/2026-10-14-docmyrepos-mvp/design.md
  - packages/server/src/db/advisory-lock.ts
  - packages/server/src/sync/requests.ts
  - packages/server/src/sync/runs.ts
  - packages/server/src/jobs/core.ts
generated: 2026-10-10
verified: 2026-10-27
stale_after: 2999-01-01
---

# Serialize syncs with advisory locks, no job queue

## Context

Webhooks can arrive in bursts, twice, or out of order. Two syncs of the same repository must never run at once, a request that arrives during a sync must not be lost, and a retried delivery must be harmless. A webhook also has to be answered within seconds.

## Decision

Each repository sync takes a Postgres session-level advisory lock, in try mode. The key is computed in JavaScript from a namespace and the repository's GitHub id, so it can be taken before the repository's row exists. A request that finds the lock busy has already recorded `repos.sync_requested_at`; the lock holder looks at that marker after it unlocks and runs again if it is set. This is the coalescing described in the [sync engine](../architecture/sync-engine.md#coalescing). The webhook is answered quickly and the sync continues in the background of the Node process.

Runs are tracked in `sync_runs`, but liveness is decided by a run-level advisory lock, never by the row's status, so a crashed process cannot leave a repository stuck.

## Consequences

- No queue service, and no extra component to deploy.
- A lock dies with its connection, so a crash frees the repository without cleanup.
- Work in the background is lost on restart or on a serverless platform. This is acceptable because a sync is incremental and resumable, and the scheduler and the rerun markers pick up what a restart interrupted. The target is a Node server, which is what the Docker image runs.
- The database must be reached directly, or through a pooler in session mode. PgBouncer in transaction mode breaks session-level locks.
- The connection pool must be large enough for the locks a run holds; the engine clamps repository concurrency to what the pool can serve.
- Background work is submitted as jobs (`sync.full`, `sync.repo`, `sync.drain`, `sync.reap`, `webhook.dispatch`) to a jobs adapter. The open-source default runs each job in the server process at once, which is the behavior described here. A [host app](../reference/extension-api.md) can give a queue instead, whose workers run the jobs with `app.jobs.run`. The locks and rerun markers live in the tenant's database, so they serialize and coalesce syncs the same way whichever process runs the job: two copies of one job leave the state of one sync.

## Alternatives considered

- **A job queue (BullMQ, pg-boss).** Not in the open-source app, which still needs no queue. A host app can plug one in through the jobs adapter; the core does not depend on one.
- **A `sync_runs` row with a unique "running" guard.** A crashed process leaves the row behind and blocks later syncs, while an advisory lock goes away with its connection.
- **Dropping requests that find the repository busy.** Loses a push that lands after the running sync fetched its tree.
