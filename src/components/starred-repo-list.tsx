"use client";

import { useId, useRef } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type Modifier,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { RepoLine, repoLabel, rowButton, type RepoAccessRow } from "./repo-access-row";

/**
 * The starred repositories of the admin Repository access page, as a sortable list (admin page
 * only; nothing else imports @dnd-kit). Only the handle starts a drag, so the Star and Allow/Block
 * buttons and the text keep working normally. Move up / Move down are the no-drag alternative
 * (WCAG 2.2, 2.5.7) and share `onReorder` with the drop. `touch-action: none` on the handle lets
 * a touch drag move the row instead of scrolling the page.
 */
export interface StarredRepoListProps {
  /** In starred order. */
  readonly repos: readonly RepoAccessRow[];
  readonly busyId: number | null;
  /** A reorder request is in flight: drags and moves are paused. */
  readonly reordering: boolean;
  readonly onReorder: (next: RepoAccessRow[]) => void;
  readonly onToggleStar: (repo: RepoAccessRow) => void;
  readonly onToggleAllowed: (repo: RepoAccessRow) => void;
}

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

function GripIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4" fill="currentColor">
      {[4, 8, 12].flatMap((y) =>
        [5.5, 10.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.2" />),
      )}
    </svg>
  );
}

interface SortableRowProps extends Omit<StarredRepoListProps, "repos" | "onReorder"> {
  readonly repo: RepoAccessRow;
  readonly index: number;
  readonly count: number;
  readonly onMove: (delta: -1 | 1) => void;
}

function SortableRow({ repo, index, count, onMove, ...actions }: SortableRowProps) {
  const label = repoLabel(repo);
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: repo.id, disabled: actions.reordering });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      aria-label={`Reorder ${label}`}
      disabled={actions.reordering}
      {...attributes}
      {...listeners}
      className="-ml-1 inline-flex size-8 shrink-0 cursor-grab touch-none items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-50"
    >
      <GripIcon />
    </button>
  );
  const moves = (
    <>
      {index > 0 ? (
        <button
          type="button"
          disabled={actions.reordering}
          aria-label={`Move up ${label}`}
          onClick={() => onMove(-1)}
          className={rowButton}
        >
          Up
        </button>
      ) : null}
      {index < count - 1 ? (
        <button
          type="button"
          disabled={actions.reordering}
          aria-label={`Move down ${label}`}
          onClick={() => onMove(1)}
          className={rowButton}
        >
          Down
        </button>
      ) : null}
    </>
  );
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`relative border-b border-border bg-background py-3 ${isDragging ? "z-10 outline outline-1 outline-border" : ""}`}
    >
      <RepoLine
        repo={repo}
        busy={actions.busyId === repo.id}
        onToggleStar={actions.onToggleStar}
        onToggleAllowed={actions.onToggleAllowed}
        handle={handle}
        moves={moves}
      />
    </li>
  );
}

export function StarredRepoList({ repos, onReorder, ...actions }: StarredRepoListProps) {
  const contextId = useId();
  const sensors = useSensors(
    // A small distance, so a click on the handle is not a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids: UniqueIdentifier[] = repos.map((r) => r.id);
  const count = repos.length;
  const name = (id: UniqueIdentifier) => {
    const repo = repos.find((r) => r.id === id);
    return repo ? repoLabel(repo) : "repository";
  };
  const place = (id: UniqueIdentifier) => `position ${ids.indexOf(id) + 1} of ${count}`;

  // dnd-kit reports "over" once right after the pick-up (the row over its own place); announcing
  // it would replace "Picked up ..." before a screen reader finished it.
  const justPickedUp = useRef(false);
  const announcements: Announcements = {
    onDragStart: ({ active }) => {
      justPickedUp.current = true;
      return `Picked up ${name(active.id)}, ${place(active.id)}.`;
    },
    onDragOver: ({ active, over }) => {
      if (justPickedUp.current) {
        justPickedUp.current = false;
        return undefined;
      }
      return over ? `${name(active.id)} moved to ${place(over.id)}.` : undefined;
    },
    onDragEnd: ({ active, over }) =>
      over
        ? `Dropped ${name(active.id)} at ${place(over.id)}.`
        : `Dropped ${name(active.id)}, ${place(active.id)}.`,
    onDragCancel: ({ active }) => `Cancelled. ${name(active.id)} stays at ${place(active.id)}.`,
  };

  function move(from: number, to: number) {
    if (from === to || to < 0 || to >= count) return;
    onReorder(arrayMove([...repos], from, to));
  }

  function onDragEnd({ active, over }: DragEndEvent) {
    if (!over) return;
    move(ids.indexOf(active.id), ids.indexOf(over.id));
  }

  return (
    <DndContext
      id={contextId}
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[verticalOnly]}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable:
            "To pick up a repository, press space or enter on its handle. Use the up and down arrow keys to move it, space or enter to drop it, and escape to cancel.",
        },
      }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul>
          {repos.map((repo, index) => (
            <SortableRow
              key={repo.id}
              repo={repo}
              index={index}
              count={count}
              onMove={(delta) => move(index, index + delta)}
              {...actions}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
