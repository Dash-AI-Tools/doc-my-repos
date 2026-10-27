import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminUsersPage } from "@docmyrepos/ui/pages/admin-users";

export const dynamic = "force-dynamic";

export default bindPage(AdminUsersPage, app);
