import { app } from "@/docmyrepos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const { GET, HEAD, POST, PUT, PATCH, DELETE } = app.routes.accountTokens;
