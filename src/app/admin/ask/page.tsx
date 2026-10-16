import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** Ask settings moved into a tab of the Workspace configuration page; old links still work. */
export default function AdminAskRedirect(): never {
  redirect("/admin/workspace?tab=ask");
}
