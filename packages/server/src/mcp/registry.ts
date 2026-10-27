import { getOkfGuidelines, validateOkfDocumentTool, writeOkfDoc } from "./authoring";
import { getDocument, getRepository, listRepositories, searchDocumentsTool } from "./tools";
import type { PromptDefinition, ToolDefinition } from "./tool-types";

/**
 * The tools and prompts the endpoint offers. Every tool is read-only (the adapter declares it so).
 * `tools.ts` holds the repository, search and document tools; `authoring.ts` the OKF guidelines and
 * validation tools and the `write-okf-doc` prompt.
 */
export const TOOLS: readonly ToolDefinition[] = [
  listRepositories,
  getRepository,
  searchDocumentsTool,
  getDocument,
  getOkfGuidelines,
  validateOkfDocumentTool,
];
export const PROMPTS: readonly PromptDefinition[] = [writeOkfDoc];
