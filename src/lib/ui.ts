/**
 * The house form control: an underline field, not a box (DESIGN.md, "Search / Palette Trigger").
 * 36px tall, bottom border in Control Edge that turns Ink on hover; focus is drawn by the global
 * rule in `globals.css` (edge turns Ink, underline thickens). Every text field, select and
 * textarea uses this one class, so the three forms cannot drift apart.
 */
export const fieldClass =
  "w-full border-b border-input bg-transparent py-1.5 text-base transition-colors hover:border-foreground";
