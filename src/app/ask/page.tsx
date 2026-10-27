import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AskPage } from "@docmyrepos/ui/pages/ask";

export const dynamic = "force-dynamic";

export default bindPage(AskPage, app);
export { metadata } from "@docmyrepos/ui/pages/ask";
