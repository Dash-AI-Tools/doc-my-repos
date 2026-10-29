import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AskChat } from "../components/ask-chat";
import { loadAskPage, type AskPageParams } from "@docmyrepos/server/internal/ask-page";
import type { AppProps } from "../bind-page";
import { readerContext } from "../page-context";
import { askStateFor } from "@docmyrepos/server/internal/ask/settings";

/**
 * The Ask page (ask-the-docs): a chat that answers from the synced documentation, with references.
 * 404 unless an admin has turned Ask on and the provider is usable. Rendered per request; the
 * conversation lives in the browser tab only. Not a document, so read mode does not apply.
 */

export const metadata: Metadata = {
  title: "Ask",
  robots: { index: false, follow: false },
};

type PageSearchParams = Promise<AskPageParams>;

export async function AskPage({
  app,
  searchParams,
}: AppProps & { searchParams: PageSearchParams }) {
  // A visitor without a session may ask only when an admin allowed anonymous Ask (public access);
  // otherwise they are sent to sign in. Their questions are answered from public repositories.
  const { ctx, reader } = await readerContext(app, "ask");
  const view = await loadAskPage(await searchParams, {
    reader,
    db: ctx.db,
    state: () => askStateFor(ctx),
    providers: async () => (await ctx.workspace()).providers,
  });
  if (view.status === "off") notFound();
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Ask the docs</h1>
        <p className="text-muted-foreground">
          Ask in plain language. Answers come only from the synced documentation and link to the
          sections they used.
        </p>
      </div>
      {/* The chat fills the rest of the screen; its log scrolls and the question field stays put. */}
      <div className="h-[calc(100dvh-17rem)] min-h-[30rem]">
        <AskChat
          providerLabel={view.providerLabel}
          host={view.host}
          scope={view.scope}
          repos={view.repos}
          initialQuestion={view.initialQuestion}
        />
      </div>
    </div>
  );
}
