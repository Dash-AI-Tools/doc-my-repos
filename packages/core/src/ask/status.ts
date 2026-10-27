import { providerLabel } from "./providers";

/** Structural view of the server's `AskState`, so components never import server modules. */
export type AskStatusInput =
  | { readonly state: "off" }
  | { readonly state: "ready"; readonly provider: string; readonly model: string }
  | {
      readonly state: "unavailable";
      readonly missing: readonly string[];
      readonly problem?: string;
    };

export interface AskStatusLine {
  readonly tone: "neutral" | "good" | "bad";
  readonly label: string;
  readonly detail: string;
}

/** The Ask line of the status page: off, ready, or unavailable naming settings only. */
export function askStatusLine(ask: AskStatusInput): AskStatusLine {
  switch (ask.state) {
    case "off":
      return { tone: "neutral", label: "Off", detail: "An admin has not turned Ask on." };
    case "ready":
      return {
        tone: "good",
        label: "Ready",
        detail: `Using ${providerLabel(ask.provider)}, model ${ask.model}.`,
      };
    case "unavailable": {
      const parts: string[] = [];
      if (ask.missing.length > 0)
        parts.push(`Enter ${ask.missing.join(", ")} on the Ask admin page.`);
      if (ask.problem) parts.push(`${ask.problem}.`);
      if (parts.length === 0) parts.push("Choose a provider and model on the Ask admin page.");
      return { tone: "bad", label: "Unavailable", detail: parts.join(" ") };
    }
  }
}
