import { redirect } from "next/navigation";

/** The page moved to `/admin/workspace` when it was renamed; old links and bookmarks still work. */
export function AdminGithubRedirect(): never {
  redirect("/admin/workspace");
}
