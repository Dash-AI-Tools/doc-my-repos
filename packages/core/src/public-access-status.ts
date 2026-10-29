/** What the status page needs to describe public access; components never import server modules. */
export interface PublicAccessStatusInput {
  /** At least one allowed repository is public, on its own or through a folder. */
  readonly anyPublic: boolean;
  readonly searchEnabled: boolean;
  readonly askEnabled: boolean;
}

export interface PublicAccessStatusLine {
  readonly tone: "neutral" | "good";
  readonly label: string;
  readonly detail: string;
}

/**
 * The Public access line of the status page: whether visitors who are not signed in can read
 * anything, and which of search and Ask they may use. Signed-in users only; names no repository.
 */
export function publicAccessStatusLine(input: PublicAccessStatusInput): PublicAccessStatusLine {
  if (!input.anyPublic) {
    return {
      tone: "neutral",
      label: "Off",
      detail: "Nothing is public. Visitors must sign in to read anything.",
    };
  }
  const may = [input.searchEnabled ? "search" : null, input.askEnabled ? "use Ask" : null].filter(
    (part) => part !== null,
  );
  return {
    tone: "good",
    label: "On",
    detail:
      may.length === 0
        ? "Some repositories are public. Anonymous visitors can read them but not search or use Ask."
        : `Some repositories are public. Anonymous visitors can read them and ${may.join(" and ")}.`,
  };
}
