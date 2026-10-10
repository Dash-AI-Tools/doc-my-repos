import { describe, expect, it, vi } from "vitest";

import { ConfigError } from "./config/load";
import type { Db } from "./db/client";
import { loadStatusPage } from "./status-page";

const NOW = new Date("2026-10-10T12:00:00Z");

function failingDb(error: unknown): Db {
  return {
    execute() {
      throw error;
    },
    select() {
      throw error;
    },
  } as unknown as Db;
}

describe("loadStatusPage", () => {
  it("turns an unreachable database into the error state and logs only the kind", async () => {
    const log = vi.fn();
    const error = Object.assign(new Error("connect postgres://u:sentinel@h/db"), {
      code: "ECONNREFUSED",
    });
    const data = await loadStatusPage({ db: () => failingDb(error), now: () => NOW, log });
    expect(data).toEqual({ status: "error", loadedAt: NOW });
    expect(log).toHaveBeenCalledWith(
      "[status] could not load the sync status: database error (ECONNREFUSED)",
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain("sentinel");
  });

  it("turns a configuration error into the error state", async () => {
    const log = vi.fn();
    const data = await loadStatusPage({
      db: () => {
        throw new ConfigError(["SYNC_SECRET: missing"]);
      },
      now: () => NOW,
      log,
    });
    expect(data.status).toBe("error");
    expect(log).toHaveBeenCalledWith("[status] could not load the sync status: ConfigError");
  });

  it("lets an unexpected error propagate", async () => {
    await expect(
      loadStatusPage({ db: () => failingDb(new Error("bug")), log: () => undefined }),
    ).rejects.toThrow("bug");
  });
});
