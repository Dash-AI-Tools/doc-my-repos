import type { Metadata } from "next";

import { StatusLoadError, StatusView } from "../components/status-view";
import { loadStatusPage } from "@docmyrepos/server/internal/status-page";
import type { AppProps } from "../bind-page";
import { pageContext } from "../page-context";
import { askStateFor } from "@docmyrepos/server/internal/ask/settings";

/**
 * `/status` (task 12.2): a human-readable view of the sync status, the same data as
 * `GET /api/status`: the last sync run and each visible repository's sync state, errors and
 * warnings. Read from Postgres only, through the shared query layer; rendered per request. No
 * authentication: it shows what the repository pages already show.
 *
 * States: ok, and the in-page error state for an unreachable database or unusable configuration
 * (HTTP 200, like the home page). Unexpected errors go to `src/app/error.tsx`.
 */

export const metadata: Metadata = {
  title: "Sync status",
  robots: { index: false, follow: false },
};

export async function StatusPage({ app }: AppProps) {
  const ctx = await pageContext(app);
  const data = await loadStatusPage({ db: ctx.db, askState: () => askStateFor(ctx) });
  if (data.status === "error") return <StatusLoadError />;
  return (
    <StatusView
      data={data.sync}
      ask={data.ask}
      workspace={data.workspace}
      publicAccess={data.publicAccess}
      now={data.loadedAt}
    />
  );
}
