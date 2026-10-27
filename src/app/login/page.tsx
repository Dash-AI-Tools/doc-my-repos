import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { LoginPage } from "@docmyrepos/ui/pages/login";

export const dynamic = "force-dynamic";

export default bindPage(LoginPage, app);
