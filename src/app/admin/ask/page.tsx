import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AdminAskRedirect } from "@docmyrepos/ui/pages/admin-ask-redirect";

export const dynamic = "force-dynamic";

export default bindPage(AdminAskRedirect, app);
