import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** The page moved to `/admin/workspace` when it was renamed; old links and bookmarks still work. */
export default function AdminGithubRedirect(): never {
  redirect("/admin/workspace");
}
