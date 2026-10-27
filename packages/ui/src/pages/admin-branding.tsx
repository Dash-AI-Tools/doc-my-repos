import { BrandingForm } from "../components/branding-form";
import { getAdminBranding } from "@docmyrepos/server/internal/admin/service";
import type { AppProps } from "../bind-page";
import { pageContext } from "../page-context";
import { contextAccess } from "@docmyrepos/server/internal/auth/access";

/** Admin branding page (guarded by `src/app/admin/layout.tsx`). */
export async function AdminBrandingPage({ app }: AppProps) {
  const ctx = await pageContext(app);
  const branding = await getAdminBranding(ctx.db, contextAccess(ctx));
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Branding</h1>
        <p className="text-muted-foreground">
          Set the name, title, colors and logo the portal shows. Preview the result as you type,
          then save.
        </p>
      </div>
      <BrandingForm initial={branding} />
    </div>
  );
}
