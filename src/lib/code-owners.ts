import { ownerKey, type OwnerKind } from "./github-links";

/**
 * Groups CODEOWNERS rules by owner for the code owners panel (task 9.5, design decision 12: rules
 * are shown as declared, no per-file ownership is computed). Pure: no React, no database.
 *
 * Choices (spec-silent):
 * - Owners are keyed case-insensitively (`@Alice` and `@alice` are one owner, as on GitHub); the
 *   handle shown is the spelling of the first occurrence in the file.
 * - Owners are ordered by first appearance in the file, so the panel reads like the file and the
 *   first owner is usually the repository-wide default (`* @alice`).
 * - An owner's patterns keep file order; a pattern repeated for the same owner is listed once.
 * - A rule with no owners (a pattern that un-owns a path) belongs to nobody and is not shown.
 */

export interface OwnerRef {
  readonly handle: string;
  readonly kind: OwnerKind;
}

/** The structural subset of a stored rule that grouping needs. */
export interface RuleData {
  readonly pattern: string;
  readonly owners: readonly OwnerRef[];
}

export interface OwnerGroup {
  /** Case-folded handle, unique per group. */
  readonly key: string;
  /** Handle as first written in the file, with its `@`. */
  readonly handle: string;
  readonly kind: OwnerKind;
  /** Patterns this owner is named on, in file order, without duplicates. */
  readonly patterns: readonly string[];
}

export function groupByOwner(rules: readonly RuleData[]): OwnerGroup[] {
  const groups = new Map<string, { handle: string; kind: OwnerKind; patterns: Set<string> }>();
  for (const rule of rules) {
    for (const owner of rule.owners) {
      const key = ownerKey(owner.handle);
      let group = groups.get(key);
      if (group === undefined) {
        group = { handle: owner.handle, kind: owner.kind, patterns: new Set() };
        groups.set(key, group);
      }
      group.patterns.add(rule.pattern);
    }
  }
  return [...groups].map(([key, g]) => ({
    key,
    handle: g.handle,
    kind: g.kind,
    patterns: [...g.patterns],
  }));
}
