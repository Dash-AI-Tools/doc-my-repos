import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { PluginPage, generateMetadata as metadataFor } from "@docmyrepos/ui/pages/plugin";

export const dynamic = "force-dynamic";

export default bindPage(PluginPage, app);
export const generateMetadata = bindPage(metadataFor, app);
