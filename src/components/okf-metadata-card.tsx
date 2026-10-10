import Link from "next/link";
import type { ReactNode } from "react";

import {
  staleness,
  statusNotice,
  type DisplayValue,
  type OkfDate,
  type OkfMeta,
  type OkfRef,
  type OkfRefs,
} from "@/lib/okf-meta";
import { buildFilterUrl } from "@/lib/search-params";

import { DateText, daysPhrase } from "./okf-notices";

/**
 * The metadata card of an OKF document (task 11.4, OKF spec "Metadata card" and "Tolerant
 * parsing"). Presentational: it renders the `OkfMeta` view model of `src/lib/okf-meta.ts`, which
 * has already cleaned, capped and validated every value. The page mounts it only for a repository
 * that is OKF, and not for the reserved `index.md`/`log.md` (they are not typed concepts).
 *
 * - A definition list of the fields the document has; a missing field has no row (no empty rows,
 *   no placeholders). A document with only `type` shows only its type. A card with nothing to
 *   show renders nothing.
 * - `type` is shown exactly as authored, as a chip; `type`, `status` and each tag link to the
 *   repository page with that filter on (the same URL grammar as the table of contents filters).
 *   The text is the cleaned value but the link carries the value as stored (`meta.typeFilter`,
 *   `statusFilter`, `tagFilters`), so it selects the real group even for a value with zero-width
 *   marks, double spaces or over 120 characters; a stored value that cannot be a filter value at
 *   all is plain text.
 *   A status of `deprecated` or `draft` is tinted like its notice.
 * - Every value is untrusted text: React escapes it, nothing is injected as HTML. Only absolute
 *   http(s) URLs in `resource` and `sources` become links (`rel="noopener noreferrer"`); anything
 *   else is text.
 * - Producer-defined keys are listed under "Other fields" with their values (text, lists and
 *   nested mappings, depth and size capped); six or more of them are collapsed behind a native
 *   `<details>`. Long lists show their first entries and the rest behind "Show more".
 * - `generated`, `verified` and `stale_after` are formatted in UTC (`src/lib/time.ts`); a value
 *   that is not a date is shown as written with a hint. `now` only decides the wording of the
 *   `stale_after` row ("3 days ago", "in 20 days").
 */

const LONG_LIST = 8;
const MANY_FIELDS = 6;

const CHIP =
  "inline-flex min-h-6 max-w-full items-center rounded-full border px-2.5 py-0.5 text-xs font-medium no-underline";
const CHIP_NEUTRAL =
  "border-border bg-secondary text-secondary-foreground hover:bg-accent hover:text-accent-foreground";
const CHIP_TYPE = "border-border bg-okf-badge text-okf-badge-foreground hover:underline";
const CHIP_DEPRECATED =
  "border-destructive-muted-border bg-destructive-muted text-destructive-muted-foreground hover:underline";
const CHIP_DRAFT = "border-border bg-warning text-warning-foreground hover:underline";
const HINT = "text-muted-foreground italic";

function Row({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <div data-testid={testId} className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <dt className="font-medium text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** The first `LONG_LIST` entries as a list, the rest behind a native `<details>`. */
function ListWithMore({
  items,
  className,
  listClassName,
}: {
  readonly items: readonly ReactNode[];
  readonly className?: string;
  readonly listClassName: string;
}) {
  const shown = items.slice(0, LONG_LIST);
  const more = items.slice(LONG_LIST);
  return (
    <div className={className}>
      <ul role="list" className={listClassName}>
        {shown.map((item, i) => (
          <li key={i} className="min-w-0">
            {item}
          </li>
        ))}
      </ul>
      {more.length > 0 ? (
        <details data-testid="okf-show-more" className="group mt-1">
          <summary className="cursor-pointer rounded-md py-1 text-xs text-link hover:underline">
            <span className="group-open:hidden">Show {more.length} more</span>
            <span className="hidden group-open:inline">Show fewer</span>
          </summary>
          <ul role="list" className={`mt-1 ${listClassName}`}>
            {more.map((item, i) => (
              <li key={i} className="min-w-0">
                {item}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function RefLink({ item }: { readonly item: OkfRef }) {
  if (item.href === null) return <span data-testid="okf-ref-text">{item.label}</span>;
  return (
    <a
      href={item.href}
      rel="noopener noreferrer nofollow"
      data-testid="okf-ref-link"
      className="text-link underline"
    >
      {item.label}
    </a>
  );
}

function Refs({ refs }: { readonly refs: OkfRefs }) {
  return (
    <>
      <ListWithMore
        items={refs.items.map((item, i) => (
          <RefLink key={i} item={item} />
        ))}
        listClassName="flex flex-col gap-1"
      />
      {refs.omitted > 0 ? <p className={`mt-1 text-xs ${HINT}`}>and {refs.omitted} more</p> : null}
    </>
  );
}

function DateRow({
  label,
  testId,
  field,
  extra,
}: {
  readonly label: string;
  readonly testId: string;
  readonly field: OkfDate;
  readonly extra?: ReactNode;
}) {
  return (
    <Row label={label} testId={testId}>
      <DateText field={field} />
      {!field.valid ? <span className={`ml-2 text-xs ${HINT}`}>(not a valid date)</span> : null}
      {extra}
    </Row>
  );
}

function Value({ value }: { readonly value: DisplayValue }) {
  switch (value.kind) {
    case "text":
      if (value.scalar === "null") return <span className={HINT}>null</span>;
      if (value.text === "") return <span className={HINT}>(empty)</span>;
      return (
        <span className="whitespace-pre-line">
          {value.text}
          {value.truncated ? (
            <>
              …<span className="sr-only"> (shortened)</span>
            </>
          ) : null}
        </span>
      );
    case "deep":
      return <span className={HINT}>{value.summary}</span>;
    case "list":
      if (value.items.length === 0) return <span className={HINT}>(empty list)</span>;
      return (
        <>
          <ListWithMore
            items={value.items.map((item, i) => (
              <Value key={i} value={item} />
            ))}
            listClassName="list-disc pl-5"
          />
          {value.omitted > 0 ? (
            <p className={`mt-1 text-xs ${HINT}`}>and {value.omitted} more</p>
          ) : null}
        </>
      );
    case "map":
      if (value.entries.length === 0) return <span className={HINT}>(empty)</span>;
      return (
        <>
          <dl className="flex flex-col gap-1 border-l border-border pl-3">
            {value.entries.map((entry, i) => (
              <div key={i}>
                <dt className="font-mono text-xs text-muted-foreground">{entry.key}</dt>
                <dd className="min-w-0">
                  <Value value={entry.value} />
                </dd>
              </div>
            ))}
          </dl>
          {value.omitted > 0 ? (
            <p className={`mt-1 text-xs ${HINT}`}>and {value.omitted} more</p>
          ) : null}
        </>
      );
  }
}

function OtherFields({ meta }: { readonly meta: OkfMeta }) {
  const list = (
    <dl data-testid="okf-other-list" className="flex flex-col gap-2">
      {meta.unknown.map((entry, i) => (
        <div
          key={i}
          data-testid="okf-other-field"
          className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)]"
        >
          <dt className="font-mono text-xs break-words text-muted-foreground [overflow-wrap:anywhere]">
            {entry.key}
          </dt>
          <dd className="min-w-0 break-words [overflow-wrap:anywhere]">
            <Value value={entry.value} />
          </dd>
        </div>
      ))}
    </dl>
  );
  const omitted =
    meta.unknownOmitted > 0 ? (
      <p className={`mt-2 text-xs ${HINT}`}>and {meta.unknownOmitted} more fields</p>
    ) : null;
  if (meta.unknown.length < MANY_FIELDS) {
    return (
      <div data-testid="okf-other-fields" className="mt-4 border-t border-border pt-3">
        <h3 className="mb-2 text-sm font-semibold">Other fields</h3>
        {list}
        {omitted}
      </div>
    );
  }
  return (
    <details data-testid="okf-other-fields" className="group mt-4 border-t border-border pt-3">
      <summary className="cursor-pointer rounded-md text-sm font-semibold">
        Other fields ({meta.unknown.length + meta.unknownOmitted})
      </summary>
      <div className="mt-2">
        {list}
        {omitted}
      </div>
    </details>
  );
}

/**
 * A chip that filters the table of contents. The text is the cleaned value; `href` is built from
 * the stored value, or null when that value cannot be a filter (then the chip is plain text).
 */
function FilterChip({
  href,
  label,
  className,
  title,
  testId,
}: {
  readonly href: string | null;
  readonly label: string;
  readonly className: string;
  readonly title: string;
  readonly testId: string;
}) {
  if (href === null) {
    return (
      <span data-testid={testId} className={`${CHIP} ${className}`}>
        <span className="min-w-0 break-all">{label}</span>
      </span>
    );
  }
  return (
    <Link
      href={href}
      prefetch={false}
      data-testid={testId}
      className={`${CHIP} ${className}`}
      title={title}
    >
      <span className="min-w-0 break-all">{label}</span>
    </Link>
  );
}

function statusTint(status: string): string {
  const notice = statusNotice(status);
  return notice === "deprecated" ? CHIP_DEPRECATED : notice === "draft" ? CHIP_DRAFT : CHIP_NEUTRAL;
}

export interface OkfMetadataCardProps {
  readonly meta: OkfMeta;
  /** The time the page was rendered; only used for the wording of `stale_after`. */
  readonly now: Date;
  /** Root-relative path of the repository page (`/acme/kb`), the target of the filter links. */
  readonly repoPath: string;
}

export function OkfMetadataCard({ meta, now, repoPath }: OkfMetadataCardProps) {
  if (!meta.hasContent) return null;
  // `value` is the stored value (`meta.typeFilter` and friends), never the cleaned display text.
  const filterHref = (kind: "types" | "tags" | "statuses", value: string | null): string | null =>
    value === null
      ? null
      : buildFilterUrl(repoPath, {
          repos: [],
          types: kind === "types" ? [value] : [],
          tags: kind === "tags" ? [value] : [],
          statuses: kind === "statuses" ? [value] : [],
        });
  const stale = staleness(meta, now);
  const staleExtra =
    stale.state === "stale" ? (
      <span className="ml-2 text-xs text-muted-foreground">
        ({daysPhrase(stale.daysOverdue, "ago")})
      </span>
    ) : stale.state === "upcoming" ? (
      <span className="ml-2 text-xs text-muted-foreground">
        ({daysPhrase(stale.daysUntil, "in")})
      </span>
    ) : null;

  return (
    <section
      aria-labelledby="okf-meta-heading"
      data-testid="okf-metadata"
      className="mt-4 rounded-md border border-border bg-muted p-4 text-sm text-foreground"
    >
      <h2 id="okf-meta-heading" className="text-sm font-semibold">
        Document metadata
      </h2>
      <dl className="mt-3 flex flex-col gap-2">
        {meta.type !== null ? (
          <Row label="Type" testId="okf-row-type">
            <FilterChip
              href={filterHref("types", meta.typeFilter)}
              label={meta.type}
              className={CHIP_TYPE}
              title="Show documents of this type"
              testId="okf-type"
            />
          </Row>
        ) : null}
        {meta.status !== null ? (
          <Row label="Status" testId="okf-row-status">
            <FilterChip
              href={filterHref("statuses", meta.statusFilter)}
              label={meta.status}
              className={statusTint(meta.status)}
              title="Show documents with this status"
              testId="okf-status"
            />
          </Row>
        ) : null}
        {meta.tags.length > 0 ? (
          <Row label="Tags" testId="okf-row-tags">
            <ListWithMore
              items={meta.tags.map((tag, i) => (
                <FilterChip
                  key={i}
                  href={filterHref("tags", meta.tagFilters[i] ?? null)}
                  label={tag}
                  className={CHIP_NEUTRAL}
                  title="Show documents with this tag"
                  testId="okf-tag"
                />
              ))}
              listClassName="flex flex-wrap gap-1.5"
            />
            {meta.tagsOmitted > 0 ? (
              <p className={`mt-1 text-xs ${HINT}`}>and {meta.tagsOmitted} more</p>
            ) : null}
          </Row>
        ) : null}
        {meta.description !== null ? (
          <Row label="Description" testId="okf-row-description">
            <span data-testid="okf-description" className="whitespace-pre-line">
              {meta.description}
            </span>
          </Row>
        ) : null}
        {meta.resource.items.length > 0 ? (
          <Row label="Resource" testId="okf-row-resource">
            <Refs refs={meta.resource} />
          </Row>
        ) : null}
        {meta.sources.items.length > 0 ? (
          <Row label="Sources" testId="okf-row-sources">
            <Refs refs={meta.sources} />
          </Row>
        ) : null}
        {meta.generated !== null ? (
          <DateRow label="Generated" testId="okf-row-generated" field={meta.generated} />
        ) : null}
        {meta.verified !== null ? (
          <DateRow label="Verified" testId="okf-row-verified" field={meta.verified} />
        ) : null}
        {meta.staleAfter !== null ? (
          <DateRow
            label="Stale after"
            testId="okf-row-stale-after"
            field={meta.staleAfter}
            extra={staleExtra}
          />
        ) : null}
      </dl>
      {meta.unknown.length > 0 ? <OtherFields meta={meta} /> : null}
    </section>
  );
}
