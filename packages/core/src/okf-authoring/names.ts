/**
 * Where a repository keeps its OKF guidelines (mcp-agent-access design decision 7): a file named
 * `okf-guidelines.md`, matched case-insensitively, in the docs folder, or else in its `guides`
 * folder. There is no configuration key for it.
 */
export const OKF_GUIDELINES_FILE = "okf-guidelines.md";
export const OKF_GUIDELINES_FOLDER = "guides";

/** The path the file is suggested at in a docs folder (`docs/okf-guidelines.md`). */
export function suggestedGuidelinesPath(docsPath: string | null): string {
  const folder = (docsPath ?? "docs").replace(/^\/+|\/+$/g, "");
  return folder === "" ? OKF_GUIDELINES_FILE : `${folder}/${OKF_GUIDELINES_FILE}`;
}
