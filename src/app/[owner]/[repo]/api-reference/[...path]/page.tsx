import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import {
  ApiReferencePage,
  generateMetadata as metadataFor,
} from "@docmyrepos/ui/pages/api-reference";

export const dynamic = "force-dynamic";

export default bindPage(ApiReferencePage, app);
export const generateMetadata = bindPage(metadataFor, app);
