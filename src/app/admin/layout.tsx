import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminLayout } from "@docmyrepos/ui/pages/admin-layout";

export const dynamic = "force-dynamic";

export default bindPage(AdminLayout, app);
