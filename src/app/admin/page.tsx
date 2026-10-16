import Link from "next/link";

export const dynamic = "force-dynamic";

/** Admin home: links to user management, repo access, and GitHub config. */
export default function AdminPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold tracking-tight">Administration</h1>
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
            <Link href="/admin/repos" className="font-medium underline underline-offset-4">
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
            <Link href="/admin/ask" className="font-medium underline underline-offset-4">
              Ask
            </Link>
            <p className="text-sm text-muted-foreground">
              Let readers ask questions of the docs: turn it on, choose the provider and model.
            </p>
          </li>
          <li>
            <Link href="/admin/github" className="font-medium underline underline-offset-4">
              GitHub configuration
            </Link>
            <p className="text-sm text-muted-foreground">
              App installation and sync scope (read-only).
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
