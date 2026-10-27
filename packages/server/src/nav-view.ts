import "server-only";

import { cookies } from "next/headers";

import {
  NAV_VIEW_COOKIE,
  parseNavView,
  type NavView,
} from "@docmyrepos/core/internal/reading-prefs";

/** The reader's docs navigation view from the request's cookie (docs-nav-views); OKF by default. */
export async function readNavView(): Promise<NavView> {
  return parseNavView((await cookies()).get(NAV_VIEW_COOKIE)?.value);
}
