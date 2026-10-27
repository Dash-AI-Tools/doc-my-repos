import { createProxy } from "@docmyrepos/server/proxy";

export const proxy = createProxy({ publicPaths: ["/pricing"] });

export const config = {
  matcher: ["/((?!_next/static/).*)"],
};
