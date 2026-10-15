import { BrandingForm } from "@/components/branding-form";
import { getAdminBranding } from "@/server/admin/service";

export const dynamic = "force-dynamic";

/** Admin branding page (guarded by `src/app/admin/layout.tsx`). */
export default async function AdminBrandingPage() {
  const branding = await getAdminBranding();
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-3xl font-bold tracking-tight">Branding</h1>
      <BrandingForm initial={branding} />
    </div>
  );
}
