import { withDocMyRepos } from "@docmyrepos/server/next";

/**
 * The open-source app's Next.js configuration: the defaults every DocMyRepos app needs (see
 * `packages/server/src/next.ts`), and nothing of its own.
 */
export default withDocMyRepos({
  agentRules: false,
});
