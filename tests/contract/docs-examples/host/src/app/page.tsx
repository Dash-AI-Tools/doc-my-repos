import { bindPage } from "@docmyrepos/ui";
import { HomePage } from "@docmyrepos/ui/pages/home";

import { app } from "../docmyrepos";

export const dynamic = "force-dynamic";

export default bindPage(HomePage, app);
