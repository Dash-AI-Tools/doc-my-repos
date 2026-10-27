import "server-only";

import { providerLabel } from "@docmyrepos/core/internal/ask/providers";

import { getAskState, type AskState } from "./ask/settings";
import { providerAvailability, type ProviderSettingsInput } from "./ask/credentials";
import { type DbSource } from "./db/client";
import { errorFields, logger, type LogFn } from "./log";
import { getRepo, listRepos } from "./queries";
import { getWorkspace } from "./workspace";

/**
 * Data for the `/ask` page. Ask must be `ready` (on, with a usable provider); anything else is
 * `off` and the page answers 404, so a disabled Ask is invisible. The scope from `?repo=` is
 * checked through the query layer: a repository the reader cannot see is ignored. Reads Postgres
 * only; the model is never called from here.
 */

export type AskPageView =
  | { readonly status: "off" }
  | {
      readonly status: "ready";
      readonly providerLabel: string;
      readonly host: string | null;
      readonly scope: string | null;
      readonly repos: readonly string[];
      readonly initialQuestion: string;
    };

export interface AskPageParams {
  readonly repo?: string | readonly string[] | undefined;
  readonly q?: string | readonly string[] | undefined;
}

export interface AskPageDeps {
  readonly state?: () => Promise<AskState>;
  readonly db: DbSource;
  readonly providers?: () => Promise<ProviderSettingsInput>;
  readonly log?: LogFn;
}

const MAX_REPOS_LISTED = 200;
const REPO_PARAM = /^([A-Za-z0-9._-]{1,100})\/([A-Za-z0-9._-]{1,100})$/;
const MAX_PREFILL_CHARS = 2000;

const first = (value: string | readonly string[] | undefined): string =>
  (Array.isArray(value) ? value[0] : value) ?? "";

export async function loadAskPage(params: AskPageParams, deps: AskPageDeps): Promise<AskPageView> {
  const state = await (deps.state ?? (async () => getAskState(await deps.db())))();
  if (state.state !== "ready") return { status: "off" };

  const availability = providerAvailability(
    await (deps.providers ?? (async () => (await getWorkspace()).providers))(),
  );
  const host =
    state.provider === "openai-compatible" ? (availability[state.provider].host ?? null) : null;
  const initialQuestion = first(params.q).trim().slice(0, MAX_PREFILL_CHARS);

  let scope: string | null = null;
  let repos: string[] = [];
  try {
    const db = await deps.db();
    const match = REPO_PARAM.exec(first(params.repo).trim());
    const [found, listed] = await Promise.all([
      match ? getRepo(db, match[1]!, match[2]!) : Promise.resolve(null),
      listRepos(db, { limit: MAX_REPOS_LISTED }),
    ]);
    scope = found ? `${found.owner}/${found.name}` : null;
    repos = listed.map((r) => `${r.owner}/${r.name}`);
  } catch (error) {
    // The chat still works unscoped; the scope picker is simply empty.
    (deps.log ?? logger.error)("ask.page.load_failed", errorFields(error));
  }

  return {
    status: "ready",
    providerLabel: providerLabel(state.provider),
    host,
    scope,
    repos,
    initialQuestion,
  };
}
