import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { RepoDocsRedirect } from "@docmyrepos/ui/pages/repo-docs-redirect";

export const dynamic = "force-dynamic";

export default bindPage(RepoDocsRedirect, app);
