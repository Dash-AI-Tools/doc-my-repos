import type { JsonValue } from "./json";
import type { SlotContributions } from "./slots";
import { EXTENSION_API_VERSION } from "./version";

/**
 * A plugin: a plain object that adds routes, pages, jobs, schedules, migrations and UI slot
 * contributions to an app without changing the core. `Ctx` is the request context and `Node` a
 * rendered UI node; `@docmyrepos/server` fixes both, so a plugin normally uses its `Plugin` type.
 */
export interface PluginDefinition<Ctx = unknown, Node = unknown> {
  /** Lowercase slug (`PLUGIN_ID_PATTERN`). Routes, pages, jobs and the database schema use it. */
  readonly id: string;
  /** The extension API major version the plugin was written for (`EXTENSION_API_VERSION`). */
  readonly apiVersion: number;
  /** HTTP handlers served at `/api/plugins/<id>/<path>`. */
  readonly routes?: readonly PluginRoute<Ctx>[];
  /** Server-rendered pages served at `/-/<id>/<path>` inside the site layout. */
  readonly pages?: readonly PluginPage<Ctx, Node>[];
  /** Named jobs; each name starts with `<id>.`. */
  readonly jobs?: readonly PluginJob<Ctx>[];
  /** Jobs the built-in scheduler runs periodically for every tenant. */
  readonly schedules?: readonly PluginSchedule[];
  /** SQL migrations, applied after the core's into the plugin's own database schema. */
  readonly migrations?: { readonly folder: string };
  /** UI slot contributions. */
  readonly slots?: SlotContributions<Ctx, Node>;
}

export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PluginRoute<Ctx> {
  readonly method: HttpMethod;
  /**
   * Path below `/api/plugins/<id>/`, without a leading slash (`usage`, `public/pricing`). A public
   * route's path starts with `public/`, and only a public route's path may.
   */
  readonly path: string;
  /** Served without a session. Requires the `public/` prefix. */
  readonly public?: boolean;
  /**
   * A machine endpoint (webhook, cron): skips the same-origin check on unsafe methods, so the
   * handler must authenticate the caller itself.
   */
  readonly machine?: boolean;
  handler(request: Request, ctx: Ctx): Response | Promise<Response>;
}

export interface PluginPageProps {
  /** The path segments below the page's own path. */
  readonly rest: readonly string[];
  readonly searchParams: Readonly<Record<string, string | string[] | undefined>>;
}

export interface PluginPage<Ctx, Node> {
  /** Path below `/-/<id>/`, without a leading slash. Same `public/` rule as routes. */
  readonly path: string;
  readonly public?: boolean;
  /** The document title. */
  readonly title: string;
  render(ctx: Ctx, props: PluginPageProps): Node | Promise<Node>;
}

export interface PluginJob<Ctx> {
  /** `<plugin id>.<name>`. */
  readonly name: string;
  handler(payload: JsonValue, ctx: Ctx): Promise<void>;
}

export interface PluginSchedule {
  /** One of the plugin's own job names. */
  readonly job: string;
  /** At least `MIN_SCHEDULE_MS`. */
  readonly everyMs: number;
}

export const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
/** The shortest schedule interval: one minute. */
export const MIN_SCHEDULE_MS = 60_000;

const PATH_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/;

function pathProblems(kind: string, path: string, isPublic: boolean): string[] {
  const segments = path.split("/");
  if (path === "" || segments.some((s) => !PATH_SEGMENT.test(s))) {
    return [`${kind} "${path}": a path is lowercase segments separated by "/"`];
  }
  const underPublic = segments[0] === "public";
  if (isPublic && !underPublic) return [`${kind} "${path}": a public path starts with "public/"`];
  if (!isPublic && underPublic) {
    return [`${kind} "${path}": only a public ${kind} may use the "public/" prefix`];
  }
  return [];
}

/**
 * Any plugin, whatever its context and node types: `never` accepts every context (it is only
 * received), `unknown` every node (it is only returned).
 */
export type AnyPluginDefinition = PluginDefinition<never, unknown>;

/** Everything wrong with a plugin definition; empty when it is valid. Names only, no values. */
export function pluginProblems(plugin: AnyPluginDefinition): string[] {
  const problems: string[] = [];
  const id = typeof plugin?.id === "string" ? plugin.id : String(plugin?.id);
  if (!PLUGIN_ID_PATTERN.test(id)) {
    problems.push(`plugin id "${id}" is not a lowercase slug`);
  }
  if (plugin?.apiVersion !== EXTENSION_API_VERSION) {
    problems.push(
      `plugin "${id}" targets extension API ${String(plugin?.apiVersion)}; this core supports ${EXTENSION_API_VERSION}`,
    );
  }
  const routes = new Set<string>();
  for (const route of plugin.routes ?? []) {
    problems.push(...pathProblems("route", route.path, route.public === true));
    const key = `${route.method} ${route.path}`;
    if (routes.has(key)) problems.push(`route "${key}" is registered twice`);
    routes.add(key);
  }
  const pages = new Set<string>();
  for (const page of plugin.pages ?? []) {
    problems.push(...pathProblems("page", page.path, page.public === true));
    if (pages.has(page.path)) problems.push(`page "${page.path}" is registered twice`);
    pages.add(page.path);
  }
  const jobs = new Set<string>();
  for (const job of plugin.jobs ?? []) {
    if (!job.name.startsWith(`${id}.`) || job.name.length === id.length + 1) {
      problems.push(`job "${job.name}" must be named "${id}.<name>"`);
    }
    if (jobs.has(job.name)) problems.push(`job "${job.name}" is registered twice`);
    jobs.add(job.name);
  }
  for (const schedule of plugin.schedules ?? []) {
    if (!jobs.has(schedule.job)) {
      problems.push(`schedule for "${schedule.job}" names no job of this plugin`);
    }
    if (!Number.isInteger(schedule.everyMs) || schedule.everyMs < MIN_SCHEDULE_MS) {
      problems.push(`schedule for "${schedule.job}" must run at most once a minute`);
    }
  }
  return problems;
}

export class PluginDefinitionError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`Invalid plugin: ${problems.join("; ")}`);
    this.name = "PluginDefinitionError";
    this.problems = Object.freeze([...problems]);
  }
}

/** Checks a plugin definition and returns it unchanged. Throws `PluginDefinitionError`. */
export function definePlugin<P extends AnyPluginDefinition>(plugin: P): P {
  const problems = pluginProblems(plugin);
  if (problems.length > 0) throw new PluginDefinitionError(problems);
  return plugin;
}
