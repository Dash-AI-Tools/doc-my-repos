import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { DocPage, generateMetadata as metadataFor } from "@docmyrepos/ui/pages/doc";

export const dynamic = "force-dynamic";

export default bindPage(DocPage, app);
export const generateMetadata = bindPage(metadataFor, app);
