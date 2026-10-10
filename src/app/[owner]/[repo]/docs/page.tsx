import { redirect } from "next/navigation";

import { repoUrl } from "@/lib/routes";

/**
 * `/<owner>/<repo>/docs` has no page of its own: the table of contents is on the repository page,
 * so it leads there. The address is not checked here; the repository page answers 404 for an
 * unknown or malformed one.
 */
export const dynamic = "force-dynamic";

export default async function DocsIndexRedirect({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { owner, repo } = await params;
  redirect(repoUrl(owner, repo));
}
