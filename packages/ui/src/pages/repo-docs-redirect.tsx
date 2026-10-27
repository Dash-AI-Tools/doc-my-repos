import { notFound, redirect } from "next/navigation";

import { repoUrl } from "@docmyrepos/core/internal/routes";
import { isRepoRoute } from "@docmyrepos/server/internal/repo-page";

/**
 * `/<owner>/<repo>/docs` has no page of its own: the table of contents is on the repository page,
 * so it leads there. The owner and repository name must be able to name a repository
 * (`isRepoRoute`, no I/O), else the answer is 404 and nothing is redirected: a raw `%20` would
 * otherwise be encoded a second time (`%2520`). Whether the repository exists is for the
 * repository page to say.
 */

export async function RepoDocsRedirect({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  if (!isRepoRoute(owner, repo)) notFound();
  redirect(repoUrl(owner, repo));
}
