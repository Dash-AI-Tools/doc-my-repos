import { notFound, redirect } from "next/navigation";

import { repoUrl } from "@/lib/routes";
import { isRepoRoute } from "@/server/repo-page";

/**
 * `/<owner>/<repo>/docs` has no page of its own: the table of contents is on the repository page,
 * so it leads there. The owner and repository name must be able to name a repository
 * (`isRepoRoute`, no I/O), else the answer is 404 and nothing is redirected: a raw `%20` would
 * otherwise be encoded a second time (`%2520`). Whether the repository exists is for the
 * repository page to say.
 */
export const dynamic = "force-dynamic";

export default async function DocsIndexRedirect({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  if (!isRepoRoute(owner, repo)) notFound();
  redirect(repoUrl(owner, repo));
}
