import "./globals.css";

import { app } from "@/docmyrepos";
import { bindPage } from "@docmyrepos/ui";
import { RootLayout, generateMetadata as metadataFor } from "@docmyrepos/ui/pages/root-layout";

export default bindPage(RootLayout, app);
export const generateMetadata = bindPage(metadataFor, app);
export { viewport } from "@docmyrepos/ui/pages/root-layout";
