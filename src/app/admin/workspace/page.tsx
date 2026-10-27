import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminWorkspacePage } from "@docmyrepos/ui/pages/admin-workspace";

export const dynamic = "force-dynamic";

export default bindPage(AdminWorkspacePage, app);
