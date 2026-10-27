import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { SearchPage, generateMetadata as metadataFor } from "@docmyrepos/ui/pages/search";

export const dynamic = "force-dynamic";

export default bindPage(SearchPage, app);
export const generateMetadata = bindPage(metadataFor, app);
