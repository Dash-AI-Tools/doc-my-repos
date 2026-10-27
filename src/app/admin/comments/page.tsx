import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminCommentsPage } from "@docmyrepos/ui/pages/admin-comments";

export const dynamic = "force-dynamic";

export default bindPage(AdminCommentsPage, app);
