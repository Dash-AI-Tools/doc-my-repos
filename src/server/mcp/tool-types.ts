import type { z } from "zod";

import type { Db } from "../db/client";
import type { Logger } from "../log";

/**
 * What a tool is, without the MCP SDK (mcp-agent-access design decision 1: a thin adapter between
 * the SDK and the tool layer, so the tools never import the SDK and the protocol library can be
 * replaced without touching them). `server.ts` is the only module that registers these with the SDK.
 */

/** The signed-in user a token acts as, and everything a tool needs to answer one call. */
export interface ToolContext {
  readonly db: Db;
  readonly user: { readonly id: number; readonly email: string; readonly role: "admin" | "user" };
  /** The token's row id, for logs. Never the token. */
  readonly tokenRef: number;
  /** The portal's origin as the caller reached it, for links in results. */
  readonly origin: string;
  readonly log: Logger;
  /** The current time; a test can fix it. */
  readonly now: () => Date;
}

/** A tool's answer: data for programs, a short text for clients that only read text. */
export interface ToolOutput {
  readonly structured: Record<string, unknown>;
  readonly text: string;
  /** True for a failure the caller should see (an unknown document, an invalid request). */
  readonly isError?: boolean;
}

export type InputShape = Record<string, z.ZodType>;

export interface ToolDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputShape: InputShape;
  readonly run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
}

/** Declares a tool with typed arguments; the stored form takes the arguments as validated by the SDK. */
export function defineTool<S extends InputShape>(definition: {
  name: string;
  title: string;
  description: string;
  inputShape: S;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolOutput>;
}): ToolDefinition {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputShape: definition.inputShape,
    run: (args, ctx) => definition.run(args as z.infer<z.ZodObject<S>>, ctx),
  };
}

export interface PromptDefinition {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly argsShape: InputShape;
  /** The prompt's text for the given (already validated) arguments. */
  readonly render: (args: Record<string, unknown>) => string;
}

export function definePrompt<S extends InputShape>(definition: {
  name: string;
  title: string;
  description: string;
  argsShape: S;
  render: (args: z.infer<z.ZodObject<S>>) => string;
}): PromptDefinition {
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    argsShape: definition.argsShape,
    render: (args) => definition.render(args as z.infer<z.ZodObject<S>>),
  };
}
