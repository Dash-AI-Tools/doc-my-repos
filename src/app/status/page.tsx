import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { StatusPage } from "@docmyrepos/ui/pages/status";

export const dynamic = "force-dynamic";

export default bindPage(StatusPage, app);
export { metadata } from "@docmyrepos/ui/pages/status";
