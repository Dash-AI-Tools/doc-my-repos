import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listOwn: vi.fn(),
  create: vi.fn(),
  revokeOwn: vi.fn(),
  listAll: vi.fn(),
  revokeAny: vi.fn(),
}));
vi.mock("@/server/mcp/token-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/mcp/token-api")>()),
  handleListOwnTokens: mocks.listOwn,
  handleCreateToken: mocks.create,
  handleRevokeOwnToken: mocks.revokeOwn,
  handleListAllTokens: mocks.listAll,
  handleRevokeAnyToken: mocks.revokeAny,
}));

import * as adminList from "@/app/api/admin/tokens/route";
import * as adminOne from "@/app/api/admin/tokens/[id]/route";
import * as accountList from "@/app/api/account/tokens/route";
import * as accountOne from "@/app/api/account/tokens/[id]/route";

const routes = { accountList, accountOne, adminList, adminOne };
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("token API routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("are dynamic and run on the Node.js runtime", () => {
    for (const [name, route] of Object.entries(routes)) {
      expect(route.dynamic, name).toBe("force-dynamic");
      expect(route.runtime, name).toBe("nodejs");
    }
  });

  it("hand each method to its handler with the request and the id", async () => {
    mocks.listOwn.mockResolvedValue(new Response("a"));
    mocks.create.mockResolvedValue(new Response("b"));
    mocks.revokeOwn.mockResolvedValue(new Response("c"));
    mocks.listAll.mockResolvedValue(new Response("d"));
    mocks.revokeAny.mockResolvedValue(new Response("e"));
    const request = new Request("http://localhost/x");
    expect(await (await accountList.GET(request)).text()).toBe("a");
    expect(await (await accountList.POST(request)).text()).toBe("b");
    expect(await (await accountOne.DELETE(request, ctx("7"))).text()).toBe("c");
    expect(await (await adminList.GET(request)).text()).toBe("d");
    expect(await (await adminOne.DELETE(request, ctx("8"))).text()).toBe("e");
    expect(mocks.revokeOwn).toHaveBeenCalledWith(request, "7");
    expect(mocks.revokeAny).toHaveBeenCalledWith(request, "8");
  });

  it("answer other methods with 405 and an Allow header, calling no handler", () => {
    const cases: [string, (() => Response)[], string][] = [
      [
        "account list",
        [accountList.HEAD, accountList.PUT, accountList.PATCH, accountList.DELETE],
        "GET, POST",
      ],
      [
        "account one",
        [accountOne.GET, accountOne.HEAD, accountOne.POST, accountOne.PUT, accountOne.PATCH],
        "DELETE",
      ],
      [
        "admin list",
        [adminList.HEAD, adminList.POST, adminList.PUT, adminList.PATCH, adminList.DELETE],
        "GET",
      ],
      [
        "admin one",
        [adminOne.GET, adminOne.HEAD, adminOne.POST, adminOne.PUT, adminOne.PATCH],
        "DELETE",
      ],
    ];
    for (const [name, handlers, allow] of cases) {
      for (const handler of handlers) {
        const res = handler();
        expect(res.status, name).toBe(405);
        expect(res.headers.get("allow"), name).toBe(allow);
        expect(res.headers.get("cache-control"), name).toBe("no-store");
      }
    }
    for (const mock of Object.values(mocks)) expect(mock).not.toHaveBeenCalled();
  });
});
