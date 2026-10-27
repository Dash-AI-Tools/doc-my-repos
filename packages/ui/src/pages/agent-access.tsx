import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { AgentAccess } from "../components/agent-access";
import type { TokenRow } from "@docmyrepos/core/internal/agent-access";
import { loadOwnTokenRows } from "@docmyrepos/server/internal/mcp/token-views";
import { MAX_ACTIVE_TOKENS } from "@docmyrepos/server/internal/mcp/tokens";
import { mcpEnabled } from "@docmyrepos/server/internal/workspace";
import type { AppProps } from "../bind-page";
import { pageContext } from "../page-context";

/**
 * AI agent access (mcp-agent-access spec `agent-tokens`): connection help, token creation and the
 * signed-in user's own tokens. 404 when an admin has turned the MCP endpoint off; signed-out
 * visitors are sent to sign in. Rendered per request. The page holds token rows (prefix, dates,
 * status), never a token or a hash.
 */

export const metadata: Metadata = {
  title: "AI agent access",
  robots: { index: false, follow: false },
};

export async function AgentAccessPage({ app }: AppProps) {
  const ctx = await pageContext(app);
  const enabled = await mcpEnabled(ctx).catch(() => false);
  if (!enabled) notFound();
  const user = await ctx.user();
  if (!user) redirect("/login");
  let rows: TokenRow[] = [];
  let unavailable = false;
  try {
    rows = await loadOwnTokenRows(user.id, await ctx.db());
  } catch {
    unavailable = true;
  }
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">AI agent access</h1>
        <p className="text-muted-foreground">
          Let an AI agent such as Claude Code or Cursor search and read the documentation you can
          see, and check the documents it writes against Open Knowledge Format. Agents can only
          read: they cannot change anything here or on GitHub.
        </p>
      </div>
      {unavailable ? (
        <p role="alert" className="text-muted-foreground">
          Your tokens could not be loaded. Try again in a moment.
        </p>
      ) : (
        <AgentAccess initialTokens={rows} maxActive={MAX_ACTIVE_TOKENS} />
      )}
    </div>
  );
}
