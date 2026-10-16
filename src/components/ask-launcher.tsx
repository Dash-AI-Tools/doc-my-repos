"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { AskChat, type AskChatProps } from "./ask-chat";

/**
 * The floating Ask orb (bottom right). It opens the same chat as the `/ask` page in a panel; the
 * panel's expand link carries the conversation to the full page. The panel stays mounted once
 * opened, so closing it keeps the conversation while the reader moves between pages. Hidden on
 * `/ask` itself, where the full chat is already on screen.
 */
export function AskLauncher(props: Omit<AskChatProps, "variant" | "onClose" | "initialQuestion">) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  if (pathname === "/ask") return null;

  return (
    <>
      {opened ? (
        <section
          role="dialog"
          aria-label="Ask the docs"
          hidden={!open}
          data-testid="ask-panel"
          className="fixed right-4 bottom-20 z-40 h-[min(40rem,calc(100dvh-7rem))] w-[min(26rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        >
          <AskChat {...props} initialQuestion="" variant="panel" onClose={() => setOpen(false)} />
        </section>
      ) : null}
      <button
        type="button"
        aria-label={open ? "Close Ask" : "Ask the docs"}
        aria-expanded={open}
        data-testid="ask-orb"
        onClick={() => {
          setOpened(true);
          setOpen((v) => !v);
        }}
        className="fixed right-4 bottom-4 z-40 inline-flex size-12 cursor-pointer items-center justify-center rounded-full bg-primary text-xl text-primary-foreground shadow-lg hover:opacity-90"
      >
        <span aria-hidden="true">{open ? "✕" : "✦"}</span>
      </button>
    </>
  );
}
