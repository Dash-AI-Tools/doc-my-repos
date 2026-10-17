import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AdminTokenList } from "@/components/admin-token-list";
import type { AdminTokenRow } from "@/lib/agent-access";
import { loadAllTokenRows } from "@/server/mcp/token-views";
import { mcpEnabled } from "@/server/workspace";

/**
 * Every user's AI agent tokens, with revoke (guarded by `src/app/admin/layout.tsx`). 404 when the
 * MCP endpoint is off. Shows prefixes, dates and status, never a token or a hash.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AI agent tokens",
  robots: { index: false, follow: false },
};

export default async function AdminTokensPage() {
  const enabled = await mcpEnabled().catch(() => false);
  if (!enabled) notFound();
  let rows: AdminTokenRow[] | null = null;
  try {
    rows = await loadAllTokenRows();
  } catch {
    rows = null;
  }
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AI agent tokens</h1>
        <p className="mt-2 max-w-prose text-muted-foreground">
          The personal tokens users created for AI agents, newest first. A revoked token stops
          working on its next request. Revoked and expired tokens stay listed for 30 days.
        </p>
      </div>
      {rows === null ? (
        <p role="alert" className="text-muted-foreground">
          Tokens could not be loaded. Try again in a moment.
        </p>
      ) : (
        <AdminTokenList initialTokens={rows} />
      )}
    </div>
  );
}
