import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminBrandingPage } from "@docmyrepos/ui/pages/admin-branding";

export const dynamic = "force-dynamic";

export default bindPage(AdminBrandingPage, app);
