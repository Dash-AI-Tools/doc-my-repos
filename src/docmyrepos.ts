import { createApp } from "@docmyrepos/server";
import { e2eFixturesEnabled } from "@docmyrepos/core/internal/e2e-fixtures";
import { e2eFixturePlugin } from "@docmyrepos/ui/pages/e2e-plugin";

/**
 * The open-source DocMyRepos app: the core with its default hooks and adapters and no plugins.
 * Route files, the instrumentation hook and the proxy bind to it. A host app that extends
 * DocMyRepos has a module like this one that passes its own hooks, adapters and plugins.
 *
 * The e2e suite's fixture plugin is added only on its fixture server (`E2E_FIXTURES=1`).
 */
export const app = createApp({
  plugins: e2eFixturesEnabled(process.env) ? [e2eFixturePlugin] : [],
});
