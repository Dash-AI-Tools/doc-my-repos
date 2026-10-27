import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { Job, JobsAdapter, RequestContext } from "../app/types";
import { Secret } from "../config/secret";
import { CORE_JOBS } from "../jobs/core";
import type { SyncContext } from "../sync/engine";
import { recordingLogger } from "../test-logger";
import { POST } from "./github-webhook";

const SECRET = "SENTINEL-webhook-secret-tenant-a";
const TENANT = { id: "a", attributes: {} };

const push = (installationId: number) =>
  JSON.stringify({
    ref: "refs/heads/main",
    repository: { id: 101, name: "handbook", default_branch: "main" },
    installation: { id: installationId },
  });

function delivery(body: string): Request {
  return new Request("http://localhost/api/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "push",
      "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
    },
    body,
  });
}

/** The context of tenant `a`: its webhook secret, its installation 7, and `jobs`. */
function contextWith(jobs: JobsAdapter) {
  const rec = recordingLogger();
  // A sync context any use of which fails the test: a mismatched delivery must not sync.
  const sync = new Proxy({} as SyncContext, {
    get: (_target, key) => {
      throw new Error(`the sync context was used (${String(key)})`);
    },
  });
  const ctx = {
    tenant: TENANT,
    log: rec.log,
    workspace: async () => ({
      webhookSecret: new Secret(SECRET),
      github: { sync, installationId: 7 },
    }),
    adapters: { jobs },
  } as unknown as RequestContext;
  return { ctx, rec };
}

describe("POST /api/webhooks/github", () => {
  it("answers 202 at once when the jobs adapter queues the dispatch", async () => {
    const submitted: Job[] = [];
    const { ctx } = contextWith({
      submit: async (job) => {
        submitted.push(job);
        return {};
      },
    });
    const response = await POST(delivery(push(7)), undefined, ctx);
    expect(response.status).toBe(202);
    expect(submitted).toEqual([
      {
        name: "webhook.dispatch",
        payload: {
          tenantId: "a",
          event: "push",
          payload: JSON.parse(push(7)),
          deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
        },
      },
    ]);
  });

  it("acknowledges a delivery for another installation than the tenant's, and syncs nothing", async () => {
    const run = vi.fn((job: Job) => CORE_JOBS.get(job.name)!(job.payload, ctx, {}));
    const { ctx, rec } = contextWith({ submit: async (job) => ({ done: run(job) }) });
    const response = await POST(delivery(push(42)), undefined, ctx);
    expect(response.status).toBe(202);
    expect(run).toHaveBeenCalledOnce();
    await run.mock.results[0]!.value;
    expect(rec.find("webhook.decision")).toEqual([
      expect.objectContaining({ decision: "ignored", reason: "other_installation" }),
    ]);
  });

  it("verifies with the tenant's secret before submitting anything", async () => {
    const submit = vi.fn(async () => ({}));
    const { ctx } = contextWith({ submit });
    const forged = delivery(push(7));
    forged.headers.set("x-hub-signature-256", `sha256=${"0".repeat(64)}`);
    expect((await POST(forged, undefined, ctx)).status).toBe(401);
    expect(submit).not.toHaveBeenCalled();
  });
});
