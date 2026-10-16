import type { Metadata } from "next";

import { StatusLoadError, StatusView } from "@/components/status-view";
import { loadStatusPage } from "@/server/status-page";

/**
 * `/status` (task 12.2): a human-readable view of the sync status, the same data as
 * `GET /api/status`: the last sync run and each visible repository's sync state, errors and
 * warnings. Read from Postgres only, through the shared query layer; rendered per request. No
 * authentication: it shows what the repository pages already show.
 *
 * States: ok, and the in-page error state for an unreachable database or unusable configuration
 * (HTTP 200, like the home page). Unexpected errors go to `src/app/error.tsx`.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Sync status",
  robots: { index: false, follow: false },
};

export default async function StatusPage() {
  const data = await loadStatusPage();
  if (data.status === "error") return <StatusLoadError />;
  return <StatusView data={data.sync} ask={data.ask} now={data.loadedAt} />;
}
