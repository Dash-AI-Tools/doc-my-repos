import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminGithubRedirect } from "@docmyrepos/ui/pages/admin-github-redirect";

export const dynamic = "force-dynamic";

export default bindPage(AdminGithubRedirect, app);
