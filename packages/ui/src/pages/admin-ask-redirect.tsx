import { redirect } from "next/navigation";

/** Ask settings moved into a tab of the Workspace configuration page; old links still work. */
export function AdminAskRedirect(): never {
  redirect("/admin/workspace?tab=ask");
}
