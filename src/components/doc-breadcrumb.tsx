import Link from "next/link";
import { Fragment } from "react";

import { repoUrl } from "@/lib/routes";

/**
 * Breadcrumb of a document page (task 9.7): Home / owner/repo / folders / the document. A folder
 * links to its `index.md` when it has one and is plain text otherwise; the last entry is the
 * current page. Names are third-party text: React escapes them and they wrap.
 */
export interface DocBreadcrumbProps {
  readonly owner: string;
  readonly repo: string;
  readonly crumbs: readonly { readonly label: string; readonly href: string | null }[];
  readonly title: string;
}

export function DocBreadcrumb({ owner, repo, crumbs, title }: DocBreadcrumbProps) {
  return (
    <nav aria-label="Breadcrumb" data-testid="doc-breadcrumb">
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
        <li>
          <Link href="/" className="text-foreground">
            Home
          </Link>
        </li>
        <li aria-hidden="true">/</li>
        <li className="break-all">
          <Link href={repoUrl(owner, repo)} className="text-foreground">
            {owner}/{repo}
          </Link>
        </li>
        {crumbs.map((crumb, i) => (
          <Fragment key={`${i}:${crumb.label}`}>
            <li aria-hidden="true">/</li>
            <li className="break-all">
              {crumb.href === null ? (
                crumb.label
              ) : (
                <Link href={crumb.href} prefetch={false} className="text-foreground">
                  {crumb.label}
                </Link>
              )}
            </li>
          </Fragment>
        ))}
        <li aria-hidden="true">/</li>
        <li aria-current="page" className="break-words">
          {title}
        </li>
      </ol>
    </nav>
  );
}
