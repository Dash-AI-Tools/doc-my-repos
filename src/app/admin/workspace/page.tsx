import { GithubSettingsForm, type SettingsView } from "@/components/github-settings-form";
import { AskSettingsForm } from "@/components/ask-settings-form";
import { SetupGuide } from "@/components/setup-guide";
import { Tabs } from "@/components/tabs";
import { getAdminAskView } from "@/server/admin/ask";
import { getAdminSettingsView } from "@/server/admin/settings";

export const dynamic = "force-dynamic";

/** Admin workspace configuration page (guarded by `src/app/admin/layout.tsx`): App, repositories, limits, sync. */
export default async function AdminGithubPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ setup?: string; tab?: string }>;
}) {
  const [view, ask] = await Promise.all([getAdminSettingsView(), getAdminAskView()]);
  // The setup banner links here with `?setup=1`, which opens the instructions pop-up.
  const params = await searchParams;
  const openGuide = params.setup === "1";
  // Times cross to the browser as ISO text; keys are only ever "set or not".
  const iso = (k: { set: boolean; updatedAt: Date | null }) => ({
    set: k.set,
    updatedAt: k.updatedAt ? k.updatedAt.toISOString() : null,
  });
  const askInitial = {
    ...ask,
    credentials: {
      ...ask.credentials,
      anthropicKey: iso(ask.credentials.anthropicKey),
      openaiKey: iso(ask.credentials.openaiKey),
    },
  };
  // Times cross to the browser as ISO text; secrets are only ever "set or not".
  const serializable: SettingsView = {
    ...view,
    secrets: Object.fromEntries(
      Object.entries(view.secrets).map(([name, s]) => [
        name,
        { set: s.set, updatedAt: s.updatedAt ? s.updatedAt.toISOString() : null },
      ]),
    ),
  };
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Workspace configuration</h1>
          <SetupGuide autoOpen={openGuide} encryptionKeyProblem={view.problems.encryptionKey} />
        </div>
        <p className="text-muted-foreground">
          The GitHub App the portal syncs from, which repositories it shows, how it syncs, and Ask.
          Changes apply to the next sync, webhook or question; no restart is needed.
        </p>
      </div>
      <Tabs
        label="Configuration categories"
        initial={params.tab ?? "github"}
        tabs={[
          {
            id: "github",
            label: "GitHub & sync",
            panel: <GithubSettingsForm initial={serializable} />,
          },
          {
            id: "ask",
            label: "Ask",
            panel: (
              <>
                <p className="text-muted-foreground">
                  Let readers ask questions in plain language and get answers from the synced
                  documentation, with references. Choose the provider and model and enter its
                  credentials here.
                </p>
                <AskSettingsForm initial={askInitial} />
              </>
            ),
          },
        ]}
      />
    </div>
  );
}
