import "./globals.css";

import { bindPage } from "@docmyrepos/ui";
import { RootLayout } from "@docmyrepos/ui/pages/root-layout";

import { app } from "../docmyrepos";

export default bindPage(RootLayout, app);
export { generateMetadata, viewport } from "@docmyrepos/ui/pages/root-layout";
