import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { RepoPage, generateMetadata as metadataFor } from "@docmyrepos/ui/pages/repo";

export const dynamic = "force-dynamic";

export default bindPage(RepoPage, app);
export const generateMetadata = bindPage(metadataFor, app);
