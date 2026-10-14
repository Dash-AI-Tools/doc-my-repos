import { redirect } from "next/navigation";

import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/server/auth/current-user";

export const dynamic = "force-dynamic";

/** Public sign-in page. Logged-in visitors go straight home. */
export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sign in</h1>
        <p className="mt-2 text-muted-foreground">
          Sign in to browse your repositories&apos; documentation.
        </p>
      </div>
      <LoginForm />
    </div>
  );
}
