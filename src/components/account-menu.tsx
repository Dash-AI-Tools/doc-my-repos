"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";

export interface AccountMenuUser {
  readonly email: string;
  readonly role: "admin" | "user";
}

/** Admin pages offered inside the menu (starred-repos spec "Administration links"). */
const ADMIN_LINKS = [
  { href: "/admin/users", label: "Users" },
  { href: "/admin/repos", label: "Repository access" },
  { href: "/admin/github", label: "GitHub configuration" },
  { href: "/admin/branding", label: "Branding" },
] as const;

/**
 * The signed-in email as the header's account menu (starred-repos 4.1). The panel holds the admin
 * links for admins, a rule, and Sign out for everyone; it uses the popover tokens, so it stays
 * readable on a colored bar. It closes on Escape (focus back on the button), an outside pointer
 * press, activating an item, or a route change.
 */
export function AccountMenu({ user }: { user: AccountMenuUser }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // The path the menu was opened on: a later path closes it, without a setState in an effect.
  const [openedAt, setOpenedAt] = useState(pathname);
  const visible = open && openedAt === pathname;
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const panelId = `account-menu-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;

  function toggle(): void {
    if (visible) {
      setOpen(false);
      return;
    }
    setOpenedAt(pathname);
    setOpen(true);
  }

  useEffect(() => {
    if (!visible) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [visible]);

  async function onLogout(): Promise<void> {
    await fetch("/api/auth/logout", { method: "POST" });
    setOpen(false);
    router.push("/login");
    router.refresh();
  }

  return (
    <div
      ref={wrap}
      className="relative"
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next)) setOpen(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-expanded={visible}
        aria-controls={panelId}
        data-testid="account-menu-trigger"
        onClick={toggle}
        className="flex max-w-[12rem] cursor-pointer items-center gap-1.5 text-sm text-header-foreground hover:text-header-foreground hover:underline"
      >
        <span className="truncate">{user.email}</span>
        <Chevron />
      </button>
      <div
        id={panelId}
        hidden={!visible}
        data-testid="account-menu"
        className="absolute top-full right-0 z-30 mt-2 flex w-56 flex-col rounded-sm border border-border bg-popover p-1 text-popover-foreground shadow-lg"
      >
        {user.role === "admin"
          ? ADMIN_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={pathname === link.href ? "page" : undefined}
                onClick={() => setOpen(false)}
                className="rounded-sm px-3 py-2 text-sm text-popover-foreground no-underline hover:bg-muted hover:text-popover-foreground"
              >
                {link.label}
              </Link>
            ))
          : null}
        {user.role === "admin" ? (
          <div role="separator" className="my-1 border-t border-border" />
        ) : null}
        <button
          type="button"
          onClick={onLogout}
          className="cursor-pointer rounded-sm px-3 py-2 text-left text-sm text-popover-foreground hover:bg-muted"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

function Chevron() {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}
