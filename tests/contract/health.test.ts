import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createContractDatabase, type ContractDatabase } from "./support/database";
import { createHostApp } from "./host";

let database: ContractDatabase;

beforeAll(async () => {
  database = await createContractDatabase();
});

afterAll(async () => {
  await database?.drop();
});

describe("a host app composed through the public API", () => {
  it("answers GET /api/health through app.routes, from the configured database", async () => {
    const app = createHostApp(database.url);
    const response = await app.routes.health.GET(new Request("http://localhost/api/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
