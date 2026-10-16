import Link from "next/link";

import { apiSpecFormatLabel } from "@/lib/api-spec-label";
import { apiReferenceUrl } from "@/lib/routes";

/**
 * The "API reference" section of the repository page (openapi-reference, spec "API reference entry
 * on the repository page"): one row per stored spec with its title, API version, format and
 * version (as text) and a link to its reference page. Renders nothing when there are no specs, so
 * a repository without specs shows no such section. Items keep the order given (by path).
 * `ApiSpecListItem` is the structural subset of the query layer's `ApiSpecSummary`. Titles come
 * from third-party specs: React escapes them.
 */
export interface ApiSpecListItem {
  readonly path: string;
  readonly title: string;
  readonly apiVersion: string | null;
  readonly format: "openapi" | "swagger";
  readonly specVersion: string;
}

export interface ApiSpecListProps {
  readonly owner: string;
  readonly repo: string;
  readonly specs: readonly ApiSpecListItem[];
}

export function ApiSpecList({ owner, repo, specs }: ApiSpecListProps) {
  if (specs.length === 0) return null;
  return (
    <section
      aria-labelledby="api-reference-heading"
      data-testid="api-specs"
      className="min-w-0 border-t border-foreground pt-4 text-card-foreground"
    >
      <h2 id="api-reference-heading" className="text-lg font-semibold">
        API reference <span className="font-normal text-muted-foreground">({specs.length})</span>
      </h2>
      <ul role="list" className="mt-3 divide-y divide-border">
        {specs.map((spec) => {
          const href = apiReferenceUrl(owner, repo, spec.path);
          return (
            <li
              key={spec.path}
              data-testid="api-spec"
              className="min-w-0 py-3 first:pt-0 last:pb-0"
            >
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                {href === null ? (
                  <span className="font-medium break-words">{spec.title}</span>
                ) : (
                  <Link href={href} prefetch={false} className="font-medium break-words">
                    {spec.title}
                  </Link>
                )}
                {spec.apiVersion !== null ? (
                  <span className="text-sm text-muted-foreground">v{spec.apiVersion}</span>
                ) : null}
                <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                  {apiSpecFormatLabel(spec.format, spec.specVersion)}
                </span>
              </div>
              <code className="mt-1 block font-mono text-xs break-all text-muted-foreground">
                {spec.path}
              </code>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
