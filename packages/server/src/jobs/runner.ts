import type { JsonValue, TenantContext } from "@docmyrepos/core";

import type { Job, JobRunOptions, RequestContext } from "../app/types";

/** A job's work: its payload, the context of the tenant it runs for, and its abort signal. */
export type JobHandler = (
  payload: Job["payload"],
  ctx: RequestContext,
  options: JobRunOptions,
) => Promise<void>;

/** `app.jobs.run` was given a name nothing registered. Names the job, nothing else. */
export class UnknownJobError extends Error {
  readonly job: string;
  constructor(job: string) {
    super(`No job is registered as "${job}"`);
    this.name = "UnknownJobError";
    this.job = job;
  }
}

/** The job's payload names no tenant of `listTenants()`. */
export class UnknownJobTenantError extends Error {
  constructor(job: string) {
    super(`The payload of job "${job}" names no known tenant`);
    this.name = "UnknownJobTenantError";
  }
}

/** The job's payload is not what its handler takes. Names the job, never the payload. */
export class InvalidJobPayloadError extends Error {
  constructor(job: string) {
    super(`The payload of job "${job}" is not valid`);
    this.name = "InvalidJobPayloadError";
  }
}

export interface JobRunnerDeps {
  readonly handlers: ReadonlyMap<string, JobHandler>;
  readonly listTenants: () => readonly TenantContext[] | Promise<readonly TenantContext[]>;
  /** A fresh context for the tenant, with no signed-in user. */
  readonly contextOf: (tenant: TenantContext) => RequestContext;
}

/**
 * Runs one job by name for the tenant its payload names. Rejects, running nothing, when the name
 * is unknown or the tenant is not one of `listTenants()`.
 */
export function createJobRunner(deps: JobRunnerDeps) {
  return async (job: Job, options: JobRunOptions = {}): Promise<void> => {
    const handler = deps.handlers.get(job.name);
    if (handler === undefined) throw new UnknownJobError(job.name);
    const tenantId: JsonValue | undefined = job.payload?.tenantId;
    const tenant = (await deps.listTenants()).find((t) => t.id === tenantId);
    if (tenant === undefined) throw new UnknownJobTenantError(job.name);
    await handler(job.payload, deps.contextOf(tenant), options);
  };
}
