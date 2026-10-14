import { handleUpdateUser } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `PATCH /api/admin/users/:id` with any of `{role, disabled, password}`. */
export function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return params.then((p) => handleUpdateUser(Number(p.id), request));
}
