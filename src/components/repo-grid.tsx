import { RepoCard, type RepoCardData } from "./repo-card";

/**
 * The repository grid (task 9.2): lists of cards, one column on phones, two from `md`. The list
 * role is spelled out because list-style resets drop list semantics in Safari. Public and private
 * repositories are listed together (MVP, spec "Public and private both visible"); the visibility
 * filter is applied by the query that produced the lists.
 *
 * Starred repositories (admin-curated, portal-wide) lead in their own section, in the order given;
 * a repository is in exactly one section. The Repositories section is omitted when everything is
 * starred, and the Starred section when nothing is.
 */
export interface RepoGridProps {
  readonly starred?: readonly RepoCardData[];
  readonly repos: readonly RepoCardData[];
  readonly now: Date;
}

interface RepoSectionProps {
  readonly id: string;
  readonly title: string;
  readonly repos: readonly RepoCardData[];
  readonly now: Date;
}

function RepoSection({ id, title, repos, now }: RepoSectionProps) {
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="text-2xl font-bold tracking-tight">
        {title} <span className="font-normal text-muted-foreground">({repos.length})</span>
      </h2>
      <ul role="list" className="mt-6 grid border-t border-foreground md:grid-cols-2 md:gap-x-12">
        {repos.map((repo) => (
          <RepoCard key={`${repo.owner}/${repo.name}`} repo={repo} now={now} />
        ))}
      </ul>
    </section>
  );
}

export function RepoGrid({ starred = [], repos, now }: RepoGridProps) {
  return (
    <div className="flex flex-col gap-16">
      {starred.length > 0 && (
        <RepoSection id="starred-heading" title="Starred" repos={starred} now={now} />
      )}
      {repos.length > 0 && (
        <RepoSection id="repositories-heading" title="Repositories" repos={repos} now={now} />
      )}
    </div>
  );
}
