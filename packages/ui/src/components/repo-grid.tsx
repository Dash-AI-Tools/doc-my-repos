import { RepoCard, type RepoCardData } from "./repo-card";

/**
 * The repository grid (task 9.2): lists of cards, one column on phones, two from `md`. The list
 * role is spelled out because list-style resets drop list semantics in Safari. Public and private
 * repositories are listed together (MVP, spec "Public and private both visible"); the visibility
 * filter is applied by the query that produced the lists.
 *
 * Starred repositories (admin-curated, portal-wide) lead in their own section, in the order given;
 * then one section per folder (repo-folders: name, plain-text description, cards), then the
 * folderless Repositories. In the All view a repository is in exactly one section. Each section is
 * omitted when empty, so with no folders and nothing starred the page is the plain list. When
 * `folder` is given (a folder tab) only that folder is shown, with all of its repositories.
 */
export interface RepoGridFolder {
  readonly id: number;
  readonly name: string;
  readonly description: string | null;
  readonly repos: readonly RepoCardData[];
}

export interface RepoGridProps {
  readonly starred?: readonly RepoCardData[];
  readonly folders?: readonly RepoGridFolder[];
  readonly repos: readonly RepoCardData[];
  /** A selected folder tab: shows only this folder. */
  readonly folder?: RepoGridFolder | null;
  readonly now: Date;
}

interface RepoSectionProps {
  readonly id: string;
  readonly title: string;
  /** Plain text, shown as text (never parsed as Markdown or HTML). */
  readonly description?: string | null;
  readonly repos: readonly RepoCardData[];
  readonly now: Date;
}

function RepoSection({ id, title, description, repos, now }: RepoSectionProps) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-2xl font-bold tracking-tight break-words">
        {title} <span className="font-normal text-muted-foreground">({repos.length})</span>
      </h2>
      {description ? (
        <p className="mt-2 max-w-prose text-muted-foreground break-words [overflow-wrap:anywhere]">
          {description}
        </p>
      ) : null}
      <ul role="list" className="mt-6 grid border-t border-foreground md:grid-cols-2 md:gap-x-12">
        {repos.map((repo) => (
          <RepoCard key={`${repo.owner}/${repo.name}`} repo={repo} now={now} />
        ))}
      </ul>
    </section>
  );
}

export function RepoGrid({ starred = [], folders = [], repos, folder = null, now }: RepoGridProps) {
  if (folder) {
    return (
      <div className="flex flex-col gap-16">
        <RepoSection
          id={`folder-${folder.id}-heading`}
          title={folder.name}
          description={folder.description}
          repos={folder.repos}
          now={now}
        />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-16">
      {starred.length > 0 && (
        <RepoSection id="starred-heading" title="Starred" repos={starred} now={now} />
      )}
      {folders.map((f) => (
        <RepoSection
          key={f.id}
          id={`folder-${f.id}-heading`}
          title={f.name}
          description={f.description}
          repos={f.repos}
          now={now}
        />
      ))}
      {repos.length > 0 && (
        <RepoSection id="repositories-heading" title="Repositories" repos={repos} now={now} />
      )}
    </div>
  );
}
