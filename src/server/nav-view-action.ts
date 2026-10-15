"use server";

import { cookies, headers } from "next/headers";

import { NAV_VIEW_COOKIE, PREFERENCE_MAX_AGE, parseNavView } from "@/lib/reading-prefs";

/**
 * Stores the reader's docs navigation view (docs-nav-views, "Remembered navigation view"): the
 * `view` field of the selector's form. Tree sets the `docmyrepos-nav-view` cookie; OKF, and any
 * value that is not exactly `tree`, deletes it, since OKF is the default.
 *
 * A server action so the selector is a plain form: without JavaScript the POST returns the page
 * re-rendered with the new view. No redirect: after a cookie write Next.js re-renders the current
 * route, so the reader stays where they are (filters in the address included). The value comes
 * from a closed set and is only a display preference, so no session is checked; Next.js rejects a
 * cross-origin call. `Secure` is set when the form was posted from an https page, as the session
 * cookie does, so local http development keeps working.
 */
export async function setNavView(formData: FormData): Promise<void> {
  const view = parseNavView(formData.get("view"));
  const store = await cookies();
  if (view === "okf") {
    store.delete(NAV_VIEW_COOKIE);
    return;
  }
  const origin = (await headers()).get("origin") ?? "";
  store.set(NAV_VIEW_COOKIE, view, {
    path: "/",
    maxAge: PREFERENCE_MAX_AGE,
    sameSite: "lax",
    httpOnly: true,
    secure: origin.startsWith("https://"),
  });
}
