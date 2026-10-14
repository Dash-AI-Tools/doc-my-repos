import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "SENTINEL-sync-secret-4f9a1c7e";

const service = {
  syncAll: vi.fn(async () => ({
    run: {
      ran: true as const,
      runId: 1,
      value: [],
      written: true,
      status: "success" as const,
      stats: {},
      durationMs: 1,
    },
    discovery: null,
    discoveredGithubIds: [],
    removals: [],
    fatal: null,
  })),
  syncOne: vi.fn(),
};

vi.mock("@/server/sync/service", () => ({
  readConfiguredSyncSecret: vi.fn(() => SECRET),
  getSyncService: vi.fn(() => service),
}));

const { DELETE, GET, PATCH, POST, PUT, dynamic, runtime } = await import("./route");
const { getSyncService, readConfiguredSyncSecret } = await import("@/server/sync/service");

function request(method: string, headers: Record<string, string> = {}, body?: string) {
  return new Request("http://localhost/api/sync", { method, headers, body });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/sync route", () => {
  it("is dynamic and runs on the Node.js runtime", () => {
    expect(dynamic).toBe("force-dynamic");
    expect(runtime).toBe("nodejs");
  });

  it("runs the sync for an authorized POST", async () => {
    const response = await POST(request("POST", { authorization: `Bearer ${SECRET}` }));
    expect(response.status).toBe(200);
    expect(getSyncService).toHaveBeenCalledOnce();
    expect(service.syncAll).toHaveBeenCalledExactlyOnceWith({ trigger: "manual" });
  });

  it("rejects a POST without the secret and never builds the service", async () => {
    for (const headers of [{}, { authorization: "Bearer nope-nope-nope-nope" }] as Record<
      string,
      string
    >[]) {
      const response = await POST(request("POST", headers));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect(readConfiguredSyncSecret).toHaveBeenCalled();
    expect(getSyncService).not.toHaveBeenCalled();
    expect(service.syncAll).not.toHaveBeenCalled();
  });

  it.each<[string, (request: Request) => Response]>([
    ["GET", GET],
    ["PUT", PUT],
    ["PATCH", PATCH],
    ["DELETE", DELETE],
  ])("answers %s with 405 and Allow: POST, even with the secret", async (method, handler) => {
    const response = await handler(request(method, { authorization: `Bearer ${SECRET}` }));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(getSyncService).not.toHaveBeenCalled();
    expect(service.syncAll).not.toHaveBeenCalled();
  });
});
