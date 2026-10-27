import Link from "next/link";

import { SetupBanner } from "../components/setup-banner";
import { workspaceStatusLine } from "@docmyrepos/core/internal/workspace-status";
import { setupNeededFor } from "@docmyrepos/server/internal/onboarding";
import { mcpEnabled } from "@docmyrepos/server/internal/workspace";
import { currentWorkspaceState } from "@docmyrepos/server/internal/workspace-state";
import type { AppProps } from "../bind-page";
import { pageContext } from "../page-context";

/** Admin home: setup state, and links to users, repo access, comments, Ask, GitHub and branding. */
export async function AdminHomePage({ app }: AppProps) {
  const ctx = await pageContext(app);
  const setup = await setupNeededFor(ctx);
  const agentAccess = await mcpEnabled(ctx).catch(() => false);
  // The `admin.sections` slot: the core's sections, then the plugins'.
  const sections = await app.slots.resolve("admin.sections", ctx, {
    askEnabled: false,
    agentAccess,
  });
  // Names only; if the settings cannot be read the line is left out rather than guessed.
  const state = await currentWorkspaceState(ctx)
    .then(workspaceStatusLine)
    .catch(() => null);
  return (
    <div className="flex flex-col gap-6">
      {setup ? <SetupBanner /> : null}
      <h1 className="text-3xl font-bold tracking-tight">Administration</h1>
      {state ? (
        <section
          aria-label="Setup state"
          data-testid="admin-setup-state"
          className={`rounded-md border p-3 text-sm ${state.tone === "bad" ? "border-destructive" : "border-border"}`}
        >
          <p>
            <strong>Workspace settings: {state.label}.</strong>{" "}
            <Link href="/admin/workspace" className="underline underline-offset-4">
              Open Workspace configuration
            </Link>
          </p>
          {state.details.length > 0 ? (
            <ul className="mt-2 list-disc pl-5">
              {state.details.map((detail) => (
                <li key={detail} className="break-words [overflow-wrap:anywhere]">
                  {detail}
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
      <nav aria-label="Administration">
        <ul className="flex flex-col gap-3">
          {sections.map((section) => (
            <li key={section.href}>
              <Link href={section.href} className="font-medium underline underline-offset-4">
                {section.label}
              </Link>
              <p className="text-sm text-muted-foreground">{section.description}</p>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
