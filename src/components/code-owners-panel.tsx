import { groupByOwner, type OwnerGroup, type RuleData } from "@/lib/code-owners";
import { ownerLink, type OwnerKind } from "@/lib/github-links";

/**
 * The code owners panel on the repository page (task 9.5, spec "Code owners panel"). Presentational:
 * it takes the stored CODEOWNERS rules (`CodeOwnerRule[]` of the query layer, as the structural
 * `RuleData`) and groups them by owner with `groupByOwner` (`src/lib/code-owners.ts`).
 *
 * Each owner shows its kind (text label and icon, so the kind never depends on colour), a link to
 * the GitHub profile or team (plain text when the handle fails the strict check in
 * `src/lib/github-links.ts`), the number of patterns, and the patterns it covers in file order.
 * Owners with more than `COLLAPSE_AFTER` patterns show the first ones and put the rest in a
 * native `<details>`. Patterns and handles are third-party text: React escapes them, patterns wrap
 * rather than stretch the page, and no pattern is ever interpreted.
 */

/** Patterns shown before the rest move into a collapsed `<details>`. */
export const COLLAPSE_AFTER = 8;

export interface CodeOwnersPanelProps {
  readonly rules: readonly RuleData[];
  /** The repository has never been synced: say so instead of "no code owners". */
  readonly awaitingSync?: boolean;
}

const KIND_LABEL: Record<OwnerKind, string> = { user: "User", team: "Team", email: "Email" };

const ICON_PROPS = {
  width: 16,
  height: 16,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
  focusable: false,
  className: "shrink-0",
} as const;

function KindIcon({ kind }: { kind: OwnerKind }) {
  if (kind === "team") {
    return (
      <svg {...ICON_PROPS}>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20v-1a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v1" />
        <path d="M16 5.2a3 3 0 0 1 0 5.6" />
        <path d="M18 14.3a5 5 0 0 1 3 4.7v1" />
      </svg>
    );
  }
  if (kind === "email") {
    return (
      <svg {...ICON_PROPS}>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </svg>
    );
  }
  return (
    <svg {...ICON_PROPS}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
    </svg>
  );
}

const PATTERN =
  "rounded border border-border bg-code-background px-1.5 py-0.5 font-mono text-sm text-code-foreground [overflow-wrap:anywhere]";

function patternCount(n: number): string {
  return n === 1 ? "1 pattern" : `${n} patterns`;
}

function Patterns({ patterns }: { patterns: readonly string[] }) {
  const shown = patterns.slice(0, COLLAPSE_AFTER);
  const rest = patterns.slice(COLLAPSE_AFTER);
  return (
    <>
      <ul role="list" className="mt-2 flex flex-wrap gap-1.5">
        {shown.map((pattern) => (
          <li key={pattern} className="min-w-0 max-w-full">
            <code className={PATTERN}>{pattern}</code>
          </li>
        ))}
      </ul>
      {rest.length > 0 ? (
        <details className="mt-2" data-testid="owner-more-patterns">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Show {rest.length} more {rest.length === 1 ? "pattern" : "patterns"}
          </summary>
          <ul role="list" className="mt-2 flex flex-wrap gap-1.5">
            {rest.map((pattern) => (
              <li key={pattern} className="min-w-0 max-w-full">
                <code className={PATTERN}>{pattern}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

function OwnerRow({ group }: { group: OwnerGroup }) {
  const link = ownerLink(group.handle, group.kind);
  return (
    <li
      data-testid="owner-group"
      data-owner={group.key}
      className="min-w-0 py-3 first:pt-0 last:pb-0"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-muted-foreground">
          <KindIcon kind={group.kind} />
        </span>
        {link === null ? (
          <span data-testid="owner-handle" className="font-medium break-all text-foreground">
            {group.handle}
          </span>
        ) : (
          <a
            data-testid="owner-handle"
            href={link.href}
            rel={link.external ? "noopener noreferrer" : undefined}
            className="font-medium break-all"
          >
            {group.handle}
          </a>
        )}
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
          {KIND_LABEL[group.kind]}
        </span>
        <span className="text-sm text-muted-foreground">{patternCount(group.patterns.length)}</span>
      </div>
      <Patterns patterns={group.patterns} />
    </li>
  );
}

export function CodeOwnersPanel({ rules, awaitingSync = false }: CodeOwnersPanelProps) {
  const groups = groupByOwner(rules);
  return (
    <section
      aria-labelledby="code-owners-heading"
      data-testid="code-owners"
      className="min-w-0 rounded-lg border border-border bg-card p-4 text-card-foreground"
    >
      <h2 id="code-owners-heading" className="text-lg font-semibold">
        Code owners{" "}
        {groups.length > 0 ? (
          <span className="font-normal text-muted-foreground">({groups.length})</span>
        ) : null}
      </h2>
      {groups.length === 0 ? (
        <div data-testid="code-owners-empty" className="mt-2 text-sm text-muted-foreground">
          {awaitingSync ? (
            <p>Code owners appear here after the first sync.</p>
          ) : (
            <>
              <p>No code owners are defined.</p>
              <p className="mt-1">
                Add a <code className="font-mono">CODEOWNERS</code> file to{" "}
                <code className="font-mono">.github/</code>, the repository root or{" "}
                <code className="font-mono">docs/</code> to list owners here after the next sync.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            Rules as declared in <code className="font-mono">CODEOWNERS</code>. When several rules
            match a file, the last one wins.
          </p>
          <ul role="list" className="mt-3 divide-y divide-border">
            {groups.map((group) => (
              <OwnerRow key={group.key} group={group} />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
