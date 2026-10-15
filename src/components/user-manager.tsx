"use client";

import { useId, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import { fieldClass } from "@/lib/ui";

/** Row shape from the admin users API. Local copy: components take data as props. */
export interface AdminUserView {
  readonly id: number;
  readonly email: string;
  readonly role: "admin" | "user";
  readonly disabled: boolean;
}

type RoleFilter = "all" | "admin" | "user" | "disabled";
type RowAction = { id: number; kind: "disable" | "reset" };

const FILTERS: ReadonlyArray<{ value: RoleFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "admin", label: "Admins" },
  { value: "user", label: "Viewers" },
  { value: "disabled", label: "Disabled" },
];

const rowButton =
  "text-sm underline underline-offset-4 decoration-border hover:decoration-foreground disabled:opacity-50";
const primaryButton =
  "h-10 w-fit bg-foreground px-5 text-sm font-medium text-background transition-colors hover:bg-primary hover:text-primary-foreground disabled:opacity-50";
const gridCols = "md:grid-cols-[minmax(0,1fr)_9rem_7rem_auto]";

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
  } catch {}
  return { ok: response.ok, status: response.status, data };
}

function errorText(data: Record<string, unknown>, status: number): string {
  return typeof data.error === "string" ? data.error : `Request failed (${status})`;
}

/** 16 chars from an unambiguous alphabet, drawn from the browser CSPRNG. */
function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

interface Notice {
  readonly tone: "ok" | "error";
  readonly text: string;
}

export function UserManager({
  initialUsers,
  currentUserId,
}: {
  initialUsers: AdminUserView[];
  currentUserId: number;
}) {
  const router = useRouter();
  const ids = useId();
  const [users, setUsers] = useState(initialUsers);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [adding, setAdding] = useState(false);
  const [action, setAction] = useState<RowAction | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "user">("user");
  const [reveal, setReveal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [resetPassword, setResetPassword] = useState("");

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return users.filter((u) => {
      if (q && !u.email.toLowerCase().includes(q)) return false;
      if (filter === "admin") return u.role === "admin" && !u.disabled;
      if (filter === "user") return u.role === "user" && !u.disabled;
      if (filter === "disabled") return u.disabled;
      return true;
    });
  }, [users, query, filter]);

  const counts = useMemo(
    () => ({
      all: users.length,
      admin: users.filter((u) => u.role === "admin" && !u.disabled).length,
      user: users.filter((u) => u.role === "user" && !u.disabled).length,
      disabled: users.filter((u) => u.disabled).length,
    }),
    [users],
  );

  async function refresh() {
    const result = await api("/api/admin/users");
    if (result.ok && Array.isArray(result.data.users)) {
      setUsers(result.data.users as AdminUserView[]);
    }
    router.refresh();
  }

  async function onAdd(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setNotice(null);
    const result = await api("/api/admin/users", {
      method: "POST",
      body: JSON.stringify({ email, password, role }),
    });
    setCreating(false);
    if (!result.ok) {
      setNotice({ tone: "error", text: errorText(result.data, result.status) });
      return;
    }
    setNotice({ tone: "ok", text: `${email.trim().toLowerCase()} added as ${role}.` });
    setEmail("");
    setPassword("");
    setReveal(false);
    setAdding(false);
    await refresh();
  }

  async function onPatch(u: AdminUserView, patch: Record<string, unknown>, done: string) {
    setBusyId(u.id);
    setNotice(null);
    const result = await api(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    setBusyId(null);
    if (!result.ok) {
      setNotice({ tone: "error", text: errorText(result.data, result.status) });
      return false;
    }
    setAction(null);
    setResetPassword("");
    setNotice({ tone: "ok", text: done });
    await refresh();
    return true;
  }

  return (
    <div className="flex flex-col gap-10">
      <section className="flex flex-col gap-5 border-t border-foreground pt-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-bold">Add a user</h2>
            <p className="max-w-prose text-sm text-muted-foreground">
              Accounts are created by an admin. Share the password out of band; it is not shown
              again.
            </p>
          </div>
          {adding ? null : (
            <button type="button" onClick={() => setAdding(true)} className={primaryButton}>
              Add user
            </button>
          )}
        </div>
        {adding ? (
          <form onSubmit={onAdd} className="grid max-w-3xl gap-x-8 gap-y-5 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-email`} className="text-sm">
                Email
              </label>
              <input
                id={`${ids}-email`}
                type="email"
                required
                autoFocus
                autoComplete="off"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className={fieldClass}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${ids}-role`} className="text-sm">
                Role
              </label>
              <select
                id={`${ids}-role`}
                value={role}
                onChange={(e) => setRole(e.target.value === "admin" ? "admin" : "user")}
                className={fieldClass}
              >
                <option value="user">Viewer: reads documentation</option>
                <option value="admin">Admin: manages users, repositories and branding</option>
              </select>
            </div>
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <label htmlFor={`${ids}-password`} className="text-sm">
                Password <span className="text-muted-foreground">(at least 12 characters)</span>
              </label>
              <div className="flex items-end gap-4">
                <input
                  id={`${ids}-password`}
                  type={reveal ? "text" : "password"}
                  required
                  minLength={12}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={`${fieldClass} font-mono`}
                />
                <button
                  type="button"
                  onClick={() => {
                    setPassword(generatePassword());
                    setReveal(true);
                  }}
                  className={`${rowButton} shrink-0 py-1.5`}
                >
                  Generate
                </button>
                <button
                  type="button"
                  aria-pressed={reveal}
                  onClick={() => setReveal((v) => !v)}
                  className={`${rowButton} shrink-0 py-1.5`}
                >
                  {reveal ? "Hide" : "Show"}
                </button>
              </div>
            </div>
            <div className="flex items-center gap-5 md:col-span-2">
              <button type="submit" disabled={creating} className={primaryButton}>
                {creating ? "Adding…" : "Add user"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdding(false);
                  setPassword("");
                  setReveal(false);
                }}
                className={rowButton}
              >
                Cancel
              </button>
            </div>
          </form>
        ) : null}
      </section>

      <section className="flex flex-col gap-4 border-t border-foreground pt-5">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <h2 className="text-sm font-bold">
            People{" "}
            <span className="font-normal text-muted-foreground tabular-nums">{users.length}</span>
          </h2>
          <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
            <div role="group" aria-label="Filter by role" className="flex gap-4 text-sm">
              {FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  aria-pressed={filter === f.value}
                  onClick={() => setFilter(f.value)}
                  className={
                    filter === f.value
                      ? "border-b-2 border-primary pb-0.5 font-medium text-foreground"
                      : "border-b-2 border-transparent pb-0.5 text-muted-foreground hover:text-foreground"
                  }
                >
                  {f.label}{" "}
                  <span className="tabular-nums text-muted-foreground">{counts[f.value]}</span>
                </button>
              ))}
            </div>
            <div className="w-full sm:w-64">
              <label htmlFor={`${ids}-search`} className="sr-only">
                Search users by email
              </label>
              <input
                id={`${ids}-search`}
                type="search"
                placeholder="Search by email"
                autoComplete="off"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className={fieldClass}
              />
            </div>
          </div>
        </div>

        <div role="status" aria-live="polite" className="min-h-5 text-sm">
          {notice ? (
            <p className={notice.tone === "error" ? "text-destructive" : "text-foreground"}>
              {notice.text}
            </p>
          ) : null}
        </div>

        <div>
          <div
            aria-hidden="true"
            className={`hidden gap-4 border-b border-border pb-2 text-xs text-muted-foreground md:grid ${gridCols}`}
          >
            <span>User</span>
            <span>Role</span>
            <span>Status</span>
            <span className="text-right">Actions</span>
          </div>
          <ul>
            {visible.map((u) => {
              const isSelf = u.id === currentUserId;
              const open = action?.id === u.id ? action.kind : null;
              const busy = busyId === u.id;
              return (
                <li key={u.id} className="border-b border-border py-3">
                  <div className={`grid items-center gap-x-4 gap-y-2 ${gridCols}`}>
                    <div className="min-w-0">
                      <span
                        className={`break-all font-medium ${u.disabled ? "text-muted-foreground" : ""}`}
                      >
                        {u.email}
                      </span>
                      {isSelf ? (
                        <span className="ml-2 text-xs text-muted-foreground">you</span>
                      ) : null}
                    </div>
                    <div>
                      <label htmlFor={`${ids}-r${u.id}`} className="sr-only">
                        Role for {u.email}
                      </label>
                      <select
                        id={`${ids}-r${u.id}`}
                        value={u.role}
                        disabled={isSelf || busy}
                        title={isSelf ? "You cannot change your own role" : undefined}
                        onChange={(e) => {
                          const next = e.target.value === "admin" ? "admin" : "user";
                          void onPatch(
                            u,
                            { role: next },
                            `${u.email} is now ${next === "admin" ? "an admin" : "a viewer"}.`,
                          );
                        }}
                        className={`${fieldClass} text-sm disabled:opacity-60`}
                      >
                        <option value="user">Viewer</option>
                        <option value="admin">Admin</option>
                      </select>
                    </div>
                    <div className="text-sm">
                      {u.disabled ? (
                        <span className="text-destructive">Disabled</span>
                      ) : (
                        <span className="text-muted-foreground">Active</span>
                      )}
                    </div>
                    <div className="flex gap-5 md:justify-end">
                      <button
                        type="button"
                        aria-expanded={open === "reset"}
                        onClick={() => {
                          setResetPassword("");
                          setAction(open === "reset" ? null : { id: u.id, kind: "reset" });
                        }}
                        className={rowButton}
                      >
                        Reset password
                      </button>
                      {isSelf ? null : u.disabled ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            void onPatch(u, { disabled: false }, `${u.email} can sign in again.`)
                          }
                          className={rowButton}
                        >
                          Enable
                        </button>
                      ) : (
                        <button
                          type="button"
                          aria-expanded={open === "disable"}
                          onClick={() =>
                            setAction(open === "disable" ? null : { id: u.id, kind: "disable" })
                          }
                          className={rowButton}
                        >
                          Disable
                        </button>
                      )}
                    </div>
                  </div>

                  {open === "disable" ? (
                    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 bg-destructive-muted px-4 py-3 text-sm text-destructive-muted-foreground">
                      <p className="mr-auto">
                        Disable {u.email}? Their sessions stop working immediately. You can enable
                        them again later.
                      </p>
                      <button
                        type="button"
                        disabled={busy}
                        autoFocus
                        onClick={() =>
                          void onPatch(u, { disabled: true }, `${u.email} is disabled.`)
                        }
                        className="bg-destructive px-4 py-1.5 font-medium text-destructive-foreground disabled:opacity-50"
                      >
                        {busy ? "Disabling…" : "Disable user"}
                      </button>
                      <button type="button" onClick={() => setAction(null)} className={rowButton}>
                        Cancel
                      </button>
                    </div>
                  ) : null}

                  {open === "reset" ? (
                    <form
                      className="mt-3 flex flex-wrap items-end gap-x-5 gap-y-3 bg-muted px-4 py-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void onPatch(
                          u,
                          { password: resetPassword },
                          `Password reset for ${u.email}. Their sessions were signed out.`,
                        );
                      }}
                    >
                      <div className="flex min-w-56 flex-1 flex-col gap-1.5">
                        <label htmlFor={`${ids}-p${u.id}`} className="text-sm">
                          New password for {u.email}{" "}
                          <span className="text-muted-foreground">(at least 12 characters)</span>
                        </label>
                        <input
                          id={`${ids}-p${u.id}`}
                          type="text"
                          required
                          minLength={12}
                          autoFocus
                          autoComplete="off"
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          className={`${fieldClass} font-mono`}
                        />
                      </div>
                      <button
                        type="button"
                        onClick={() => setResetPassword(generatePassword())}
                        className={`${rowButton} py-1.5`}
                      >
                        Generate
                      </button>
                      <button type="submit" disabled={busy} className={primaryButton}>
                        {busy ? "Saving…" : "Set password"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setAction(null)}
                        className={`${rowButton} py-1.5`}
                      >
                        Cancel
                      </button>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {visible.length === 0 ? (
            <p className="py-8 text-sm text-muted-foreground">
              {users.length === 0
                ? "No users yet."
                : "No one matches. Clear the search or pick another filter."}
            </p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
