"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { fieldClass } from "@/lib/ui";

/** Row shape from the admin users API. Local copy: components take data as props. */
export interface AdminUserView {
  readonly id: number;
  readonly email: string;
  readonly role: "admin" | "user";
  readonly disabled: boolean;
}

async function api(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json" },
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON answer: fall back to the status text.
  }
  return { ok: response.ok, status: response.status, data };
}

function errorText(data: Record<string, unknown>, status: number): string {
  return typeof data.error === "string" ? data.error : `Request failed (${status})`;
}

export function UserManager({ initialUsers }: { initialUsers: AdminUserView[] }) {
  const router = useRouter();
  const [users, setUsers] = useState(initialUsers);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const result = await api("/api/admin/users");
    if (result.ok && Array.isArray(result.data.users)) {
      setUsers(result.data.users as AdminUserView[]);
    }
    router.refresh();
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    const result = await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, role }),
    });
    setBusy(false);
    if (!result.ok) {
      setMessage(errorText(result.data, result.status));
      return;
    }
    setEmail("");
    setPassword("");
    setMessage("User added.");
    await refresh();
  }

  async function onPatch(id: number, patch: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setMessage(null);
    const result = await api(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    if (!result.ok) {
      setMessage(errorText(result.data, result.status));
      return;
    }
    await refresh();
  }

  async function onResetPassword(id: number, userEmail: string) {
    const next = window.prompt(`New password for ${userEmail} (at least 12 characters):`);
    if (!next) return;
    await onPatch(id, { password: next });
    setMessage(`Password reset for ${userEmail}.`);
  }

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={onAdd} className="flex max-w-md flex-col gap-3">
        <h2 className="text-xl font-semibold">Add user</h2>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password (at least 12 characters)
          <input
            type="password"
            required
            minLength={12}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={fieldClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Role
          <select
            value={role}
            onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "user")}
            className={fieldClass}
          >
            <option value="user">User (viewer)</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <button
          type="submit"
          disabled={busy}
          className="w-fit rounded-md bg-primary px-4 py-2 font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add user"}
        </button>
      </form>

      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Users ({users.length})</h2>
        <ul className="flex flex-col gap-2">
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-2 rounded-md border p-3">
              <span className="font-medium">{u.email}</span>
              <span className="text-sm text-muted-foreground">
                {u.role}
                {u.disabled ? " · disabled" : ""}
              </span>
              <span className="ml-auto flex gap-2">
                <button
                  type="button"
                  onClick={() => onPatch(u.id, { role: u.role === "admin" ? "user" : "admin" })}
                  className="rounded-md border px-2 py-1 text-sm"
                >
                  Make {u.role === "admin" ? "user" : "admin"}
                </button>
                <button
                  type="button"
                  onClick={() => onResetPassword(u.id, u.email)}
                  className="rounded-md border px-2 py-1 text-sm"
                >
                  Reset password
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onPatch(
                      u.id,
                      { disabled: !u.disabled },
                      u.disabled ? undefined : `Disable ${u.email}? Their sessions stop working.`,
                    )
                  }
                  className="rounded-md border px-2 py-1 text-sm"
                >
                  {u.disabled ? "Enable" : "Disable"}
                </button>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
