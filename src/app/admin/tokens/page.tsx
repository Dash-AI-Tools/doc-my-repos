import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminTokensPage } from "@docmyrepos/ui/pages/admin-tokens";

export const dynamic = "force-dynamic";

export default bindPage(AdminTokensPage, app);
export { metadata } from "@docmyrepos/ui/pages/admin-tokens";
