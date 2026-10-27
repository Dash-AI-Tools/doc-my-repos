import { z } from "zod";

import type { RequestContext } from "../app/types";
import { drainSyncRequests, requestSync } from "../sync/engine";
import { reapStaleRuns } from "../sync/runs";
import { FullRunFailedError, runScheduledSync } from "../sync/schedule-runtime";
import type { FullRunOutcome } from "../sync/scheduler";
import type { WebhookPayload } from "../webhooks/endpoint";
import { createWebhookDispatch, webhookTasks } from "../webhooks/service";
import { requireGitHub } from "../workspace";
import { InvalidJobPayloadError, type JobHandler } from "./runner";

/**
 * The core's background jobs. Each runs over the workspace of the tenant its payload names, read
 * when the job runs, so a queued job uses the settings of the moment it runs. Syncs stay
 * serialized by the sync engine's advisory locks and coalesced by its rerun markers, whatever
 * runs the job (ADR 0002).
 */

type JobContext = Pick<RequestContext, "workspace" | "log">;

const tenantOnly = z.object({ tenantId: z.string() });
const fullPayload = tenantOnly.extend({ trigger: z.enum(["startup", "schedule"]) });
const repoPayload = tenantOnly.extend({
  githubId: z.number().int().positive(),
  trigger: z.enum(["webhook", "manual", "schedule", "startup"]),
});
const webhookPayload = tenantOnly.extend({
  event: z.string(),
  payload: z.record(z.string(), z.unknown()),
  deliveryId: z.string().nullable(),
});

function parse<T extends z.ZodType>(name: string, schema: T, payload: unknown): z.infer<T> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new InvalidJobPayloadError(name);
  return parsed.data;
}

/** The sync context of the tenant, or null before GitHub is configured. */
async function syncOf(ctx: JobContext) {
  return (await ctx.workspace()).github?.sync ?? null;
}

const jobs: Record<
  string,
  (payload: unknown, ctx: JobContext, signal?: AbortSignal) => Promise<void>
> = {
  /** `{ trigger }`: one scheduled full sync, skipped when another instance or run has it. */
  async "sync.full"(payload, ctx, signal) {
    const { trigger } = parse("sync.full", fullPayload, payload);
    const sync = await syncOf(ctx);
    const outcome: FullRunOutcome =
      sync === null
        ? { status: "skipped", reason: "not_configured" }
        : await runScheduledSync(sync, trigger, signal);
    if (outcome.status === "failed") throw new FullRunFailedError(outcome);
    if (outcome.status === "skipped") {
      ctx.log.info("sync.schedule.skipped", { trigger, reason: outcome.reason });
    }
  },
  /** `{ githubId, trigger }`: syncs one repository, or coalesces into the sync holding it. */
  async "sync.repo"(payload, ctx, signal) {
    const { githubId, trigger } = parse("sync.repo", repoPayload, payload);
    const { sync } = requireGitHub(await ctx.workspace());
    await requestSync(sync, { githubId }, { trigger, signal });
  },
  /** Runs the waiting per-repository sync requests. */
  async "sync.drain"(payload, ctx, signal) {
    parse("sync.drain", tenantOnly, payload);
    const sync = await syncOf(ctx);
    if (sync !== null) await drainSyncRequests(sync, { trigger: "schedule", signal });
  },
  /** Fails the runs a dead process left `running`. */
  async "sync.reap"(payload, ctx) {
    parse("sync.reap", tenantOnly, payload);
    const sync = await syncOf(ctx);
    if (sync !== null) await reapStaleRuns(sync.db, sync.pool, { log: sync.log });
  },
  /** `{ event, payload, deliveryId }`: routes one verified webhook delivery. */
  async "webhook.dispatch"(payload, ctx) {
    const job = parse("webhook.dispatch", webhookPayload, payload);
    const github = requireGitHub(await ctx.workspace());
    await createWebhookDispatch({
      sync: github.sync,
      installationId: github.installationId,
      tasks: webhookTasks(),
      log: ctx.log,
    })(job.event, job.payload as WebhookPayload, job.deliveryId);
  },
};

/** The core's jobs by name, for the job runner. */
export const CORE_JOBS: ReadonlyMap<string, JobHandler> = new Map(
  Object.entries(jobs).map(([name, run]) => [
    name,
    (payload, ctx, options) => run(payload, ctx, options.signal),
  ]),
);
