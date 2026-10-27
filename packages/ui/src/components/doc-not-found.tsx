"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

import { repoUrl } from "@docmyrepos/core/internal/routes";

import { ERROR_ACTION } from "./error-panel";

/**
 * The page shown when a document address matches nothing (task 9.7, spec "Missing document"): the
 * path matches no synced document, the repository is unknown or hidden, or the address cannot name
 * a document. One message for all of them, so the page reveals nothing about which. The HTTP
 * status is 404 (set by Next.js when the page calls `notFound()`).
 *
 * A not-found boundary receives no props, so this reads the route parameters to link back to the
 * repository space. The link is only built for an owner and repository name made of the
 * characters GitHub allows; anything else gets the home link alone.
 */
const NAME = /^[A-Za-z0-9._-]{1,100}$/;

export function repoSpaceHref(params: { owner?: unknown; repo?: unknown }): string | null {
  const { owner, repo } = params;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  if (!NAME.test(owner) || !NAME.test(repo) || repo === "." || repo === "..") return null;
  return repoUrl(owner, repo);
}

export function DocNotFound() {
  const params = useParams<{ owner?: string; repo?: string }>();
  const space = repoSpaceHref(params ?? {});
  return (
    <section
      aria-labelledby="not-found-heading"
      data-testid="doc-not-found"
      className="rounded-lg border border-border bg-card p-6 text-card-foreground"
    >
      <h1 id="not-found-heading" className="text-2xl font-bold tracking-tight">
        Document not found
      </h1>
      <p className="mt-2 text-muted-foreground">
        This repository has no synced document at this address. The file may have been moved,
        renamed or deleted, it may not have been synced yet, or the address may be mistyped.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        {space !== null ? (
          <Link href={space} className={ERROR_ACTION}>
            Back to the repository
          </Link>
        ) : null}
        <Link href="/" className={ERROR_ACTION}>
          Back to the home page
        </Link>
      </div>
    </section>
  );
}
