import type { Metadata } from "next";

import { RepoNotFound } from "../components/repo-not-found";

/** Rendered with HTTP 404 when the repository page calls `notFound()` (task 9.3). */
export const metadata: Metadata = { title: "Repository not found" };

export function RepoNotFoundPage() {
  return <RepoNotFound />;
}
