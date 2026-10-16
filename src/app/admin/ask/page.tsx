import { AskSettingsForm } from "@/components/ask-settings-form";
import { getAdminAskView } from "@/server/admin/ask";

export const dynamic = "force-dynamic";

/** Admin Ask page (guarded by `src/app/admin/layout.tsx`): switch, provider, model, test. */
export default async function AdminAskPage() {
  const view = await getAdminAskView();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Ask</h1>
        <p className="text-muted-foreground">
          Let readers ask questions in plain language and get answers from the synced documentation,
          with references. Choose the provider and model here; the server operator provides the
          credentials in the environment.
        </p>
      </div>
      <AskSettingsForm initial={view} />
    </div>
  );
}
