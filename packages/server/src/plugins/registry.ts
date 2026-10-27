import type { Plugin } from "../app/types";
import type { JobHandler } from "../jobs/runner";

/**
 * The plugins of an app, indexed for dispatch: by id, and their jobs by name. Built once by
 * `createApp` after the composition is validated (`pluginProblems` plus `registryProblems`).
 */
export interface PluginRegistry {
  readonly plugins: readonly Plugin[];
  plugin(id: string): Plugin | undefined;
  /** Every plugin job, as the job runner calls it. */
  readonly jobs: ReadonlyMap<string, JobHandler>;
}

/** Problems a set of valid plugins has together with the core: names only, no values. */
export function registryProblems(
  plugins: readonly Plugin[],
  coreJobs: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  for (const plugin of plugins) {
    for (const job of plugin.jobs ?? []) {
      // A name outside the plugin's namespace is already refused by `pluginProblems`.
      if (job.name.startsWith(`${plugin.id}.`) && coreJobs.has(job.name)) {
        problems.push(`job "${job.name}" is a core job`);
      }
    }
  }
  return problems;
}

export function createPluginRegistry(plugins: readonly Plugin[]): PluginRegistry {
  const byId = new Map(plugins.map((plugin) => [plugin.id, plugin]));
  const jobs = new Map<string, JobHandler>();
  for (const plugin of plugins) {
    for (const job of plugin.jobs ?? []) {
      jobs.set(job.name, (payload, ctx) => job.handler(payload, ctx));
    }
  }
  return {
    plugins: Object.freeze([...plugins]),
    plugin: (id) => byId.get(id),
    jobs,
  };
}
