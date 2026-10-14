import { handleCreateUser, handleListUsers } from "@/server/admin/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** `GET /api/admin/users`: admin-only user list (no password hashes). */
export function GET(): Promise<Response> {
  return handleListUsers();
}

/** `POST /api/admin/users` with `{email, password, role}`. 409 on duplicate email. */
export function POST(request: Request): Promise<Response> {
  return handleCreateUser(request);
}
