import Link from "next/link";

import { SetupBanner } from "@/components/setup-banner";
import { workspaceStatusLine } from "@/lib/workspace-status";
import { setupNeeded } from "@/server/onboarding";
import { currentWorkspaceState } from "@/server/workspace-state";

export const dynamic = "force-dynamic";

/** Admin home: setup state, and links to users, repo access, comments, Ask, GitHub and branding. */
export default async function AdminPage() {
  const setup = await setupNeeded();
  // Names only; if the settings cannot be read the line is left out rather than guessed.
  const state = await currentWorkspaceState()
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
          <li>
            <Link href="/admin/users" className="font-medium underline underline-offset-4">
              Users
            </Link>
            <p className="text-sm text-muted-foreground">
              Add users, change roles, disable access.
            </p>
          </li>
          <li>
            <Link
              href="/admin/workspace?tab=repos"
              className="font-medium underline underline-offset-4"
            >
              Repository access
            </Link>
            <p className="text-sm text-muted-foreground">
              Allow or block repositories for all viewers.
            </p>
          </li>
          <li>
            <Link href="/admin/comments" className="font-medium underline underline-offset-4">
              Comments
            </Link>
            <p className="text-sm text-muted-foreground">
              Review, delete and permanently remove document comments.
            </p>
          </li>
          <li>
            <Link href="/admin/workspace" className="font-medium underline underline-offset-4">
              Workspace configuration
            </Link>
            <p className="text-sm text-muted-foreground">
              The GitHub App, which repositories are shown, limits and sync.
            </p>
          </li>
          <li>
            <Link href="/admin/branding" className="font-medium underline underline-offset-4">
              Branding
            </Link>
            <p className="text-sm text-muted-foreground">
              Logo, organization name, page title and brand colors.
            </p>
          </li>
        </ul>
      </nav>
    </div>
  );
}
