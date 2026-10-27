import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminHomePage } from "@docmyrepos/ui/pages/admin-home";

export const dynamic = "force-dynamic";

export default bindPage(AdminHomePage, app);
