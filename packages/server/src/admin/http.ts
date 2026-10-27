import { authErrorResponse, requireAdmin, type CurrentUser } from "../auth/current-user";
import type { Db } from "../db/client";
import { requireSameOrigin } from "../same-origin";

/**
 * Small helpers shared by the admin JSON APIs (Ask, workspace settings): no-store responses, the
 * admin check, and a same-origin JSON body reader with a size cap. Messages are fixed text.
 */

export function noStore(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...extra } });
}

export function fieldError(field: string, message: string): Response {
  return noStore({ error: message, field }, 400);
}

export async function adminOrDenied(
  admin: ((db: Db) => Promise<CurrentUser>) | undefined,
  db: Db,
): Promise<{ admin: CurrentUser } | { denied: Response }> {
  try {
    return { admin: await (admin ?? requireAdmin)(db) };
  } catch (error) {
    return { denied: authErrorResponse(error) };
  }
}

/** The JSON body of a same-origin write, or a response to return. */
export async function readJsonBody(
  request: Request,
  maxChars: number,
): Promise<{ value: unknown } | { denied: Response }> {
  const origin = requireSameOrigin(request);
  if (!origin.ok) return { denied: noStore({ error: origin.error }, 403) };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { denied: noStore({ error: "The request body must be valid JSON" }, 400) };
  }
  if (text.length > maxChars) return { denied: noStore({ error: "Request too large" }, 413) };
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return { denied: noStore({ error: "The request body must be valid JSON" }, 400) };
  }
}
