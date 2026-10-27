import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { AgentAccessPage } from "@docmyrepos/ui/pages/agent-access";

export const dynamic = "force-dynamic";

export default bindPage(AgentAccessPage, app);
export { metadata } from "@docmyrepos/ui/pages/agent-access";
