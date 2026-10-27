import { redirect } from "next/navigation";

/** Repository access moved into a tab of the Workspace configuration page; old links still work. */
export function AdminReposRedirect(): never {
  redirect("/admin/workspace?tab=repos");
}
