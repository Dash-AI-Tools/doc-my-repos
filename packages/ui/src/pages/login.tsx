import { redirect } from "next/navigation";

import { LoginForm } from "../components/login-form";
import type { AppProps } from "../bind-page";

/** Public sign-in page. Logged-in visitors go straight home. */
export async function LoginPage({ app }: AppProps) {
  const ctx = await app.pageContext();
  if (ctx !== null && (await ctx.user()) !== null) redirect("/");
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
