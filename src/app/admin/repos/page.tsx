import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Repository access moved into a tab of the Workspace configuration page; old links still work. */
export default function AdminReposRedirect(): never {
  redirect("/admin/workspace?tab=repos");
}
