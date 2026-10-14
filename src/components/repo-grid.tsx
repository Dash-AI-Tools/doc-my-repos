import { RepoCard, type RepoCardData } from "./repo-card";

/**
 * The repository grid (task 9.2): a list of cards, one column on phones, two from `sm`, three from
 * `lg`. The list role is spelled out because list-style resets drop list semantics in Safari.
 * Public and private repositories are listed together (MVP, spec "Public and private both
 * visible"); the visibility filter is applied by the query that produced `repos`.
 */
export interface RepoGridProps {
  readonly repos: readonly RepoCardData[];
  readonly now: Date;
}

export function RepoGrid({ repos, now }: RepoGridProps) {
  return (
    <section aria-labelledby="repositories-heading">
      <h2 id="repositories-heading" className="text-2xl font-bold tracking-tight">
        Repositories <span className="font-normal text-muted-foreground">({repos.length})</span>
      </h2>
      <ul role="list" className="mt-6 grid border-t border-foreground md:grid-cols-2 md:gap-x-12">
        {repos.map((repo) => (
          <RepoCard key={`${repo.owner}/${repo.name}`} repo={repo} now={now} />
        ))}
      </ul>
    </section>
  );
}
