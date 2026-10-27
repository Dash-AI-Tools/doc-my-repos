import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { HomePage } from "@docmyrepos/ui/pages/home";

export const dynamic = "force-dynamic";

export default bindPage(HomePage, app);
