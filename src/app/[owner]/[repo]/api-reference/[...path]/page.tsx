import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { ApiReference } from "@/components/api-reference";
import { RepoLoadError } from "@/components/repo-load-error";
import { apiSpecFormatLabel } from "@/lib/api-spec-label";
import { API_REFERENCE_ROUTE_SEGMENT, repoUrl } from "@/lib/routes";
import { loadApiReference } from "@/server/api-reference-page";

/**
 * API reference page `/<owner>/<repo>/api-reference/<spec path>` (openapi-reference tasks 5.3).
 * Reads the stored spec from Postgres only (never GitHub) through the visibility-filtered loader
 * and hands it to the client widget (`ApiReference`).
 *
 * States: ok; redirect to the canonical spelling; not found (HTTP 404 through `notFound()`, for an
 * unknown, hidden or malformed address, rendered by the repository segment's `not-found.tsx`); and
 * the in-page error state for an unreachable database or unusable configuration.
 *
 * Header: repository link, spec title, API version, the format as a text badge and the link to the
 * source file on GitHub (left out when it cannot be built). Without scripts the widget cannot run:
 * a `<noscript>` notice says so and repeats the source link.
 */
export const dynamic = "force-dynamic";

type Params = Promise<{ owner: string; repo: string; path: string[] }>;

/** Percent-decodes the segments once, or null for a malformed escape (as the document page). */
function decodeSegments(raw: readonly string[]): string[] | null {
  try {
    return raw.map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

/** One read per request, shared by `generateMetadata` and the page. */
const load = cache((owner: string, repo: string, key: string) =>
  loadApiReference(owner, repo, JSON.parse(key) as string[]),
);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { owner, repo, path } = await params;
  // `generateMetadata` receives decoded segments (see the document page).
  const data = await load(owner, repo, JSON.stringify(path));
  if (data.status === "ok") {
    return {
      title: {
        absolute: `${data.spec.title} · API reference · ${data.repo.owner}/${data.repo.name}`,
      },
      alternates: { canonical: data.url },
    };
  }
  if (data.status === "not_found") return { title: "API reference not found" };
  return {};
}

const SOURCE_LINK =
  "inline-flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground";

function SourceLink({ href }: { href: string }) {
  return (
    <a data-testid="source-link" href={href} rel="noopener noreferrer" className={SOURCE_LINK}>
      View source on GitHub
    </a>
  );
}

export default async function ApiReferencePage({ params }: { params: Params }) {
  const { owner, repo: name, path: rawPath } = await params;
  const path = decodeSegments(rawPath);
  if (path === null) notFound();
  const data = await load(owner, name, JSON.stringify(path));
  if (data.status === "not_found") notFound();
  if (data.status === "redirect") redirect(data.to);
  if (data.status === "error") {
    return (
      <RepoLoadError
        href={`${repoUrl(owner, name)}/${API_REFERENCE_ROUTE_SEGMENT}/${path.map(encodeURIComponent).join("/")}`}
      />
    );
  }

  const { repo, spec, sourceUrl } = data;
  return (
    <article aria-labelledby="api-reference-title" className="flex min-w-0 flex-col gap-6">
      <header data-testid="api-reference-header" className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">
          <Link href={repoUrl(repo.owner, repo.name)} className="underline underline-offset-4">
            {repo.owner}/{repo.name}
          </Link>
        </p>
        <h1
          id="api-reference-title"
          className="text-4xl leading-[1.05] font-bold tracking-[-0.035em] break-words sm:text-5xl"
        >
          {spec.title}
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-border pb-6 text-sm text-muted-foreground">
          {spec.apiVersion !== null ? (
            <span data-testid="api-version">Version {spec.apiVersion}</span>
          ) : null}
          <span
            data-testid="api-format"
            className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
          >
            {apiSpecFormatLabel(spec.format, spec.specVersion)}
          </span>
          <code data-testid="api-source-path" className="font-mono break-all">
            {spec.path}
          </code>
          {sourceUrl !== null ? <SourceLink href={sourceUrl} /> : null}
        </div>
      </header>
      <noscript>
        <p
          data-testid="api-noscript"
          className="rounded-md bg-warning p-3 text-sm text-warning-foreground"
        >
          The API reference needs JavaScript to display.
          {sourceUrl !== null ? (
            <>
              {" "}
              <a href={sourceUrl} rel="noopener noreferrer" className="underline">
                View source on GitHub
              </a>
            </>
          ) : null}
        </p>
      </noscript>
      <ApiReference spec={spec.spec} sourceUrl={sourceUrl} />
    </article>
  );
}
