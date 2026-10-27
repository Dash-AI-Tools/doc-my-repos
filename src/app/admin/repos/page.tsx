import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminReposRedirect } from "@docmyrepos/ui/pages/admin-repos-redirect";

export const dynamic = "force-dynamic";

export default bindPage(AdminReposRedirect, app);
