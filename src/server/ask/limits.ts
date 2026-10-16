import { and, eq, gt, sql } from "drizzle-orm";

import type { Db } from "../db/client";
import { askUsage } from "../db/schema";
import type { ProviderErrorKind } from "./providers";

/**
 * Cost and abuse limits for Ask (ask-the-docs design decision 7). The daily and ten-minute limits
 * count rows of `ask_usage`, so they hold across server instances. Concurrency (one answer per
 * user, a cap per process) is in memory: a second instance can allow a second answer for the same
 * user, which the database windows still bound. A row is written when a question is accepted for
 * the model, never for a refusal or a question that finds no documents. No row holds any text.
 */

export const DAY_SECONDS = 24 * 60 * 60;
export const TEN_MINUTES_SECONDS = 10 * 60;
export const RETENTION_DAYS = 90;
/** Old rows removed per insert, so cleanup is bounded work spread over normal use. */
const CLEANUP_BATCH = 200;

export interface WindowLimits {
  readonly questionsPerDay: number;
  readonly questionsPerTenMinutes: number;
}

export type WindowDecision =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "daily" | "ten_minutes";
      /** Seconds until the oldest counted question leaves the window and one more is allowed. */
      readonly retryAfterSeconds: number;
    };

/** Seconds until `userId` may ask again for one window, or null when they are under `limit`. */
async function waitFor(
  db: Db,
  userId: number,
  windowSeconds: number,
  limit: number,
): Promise<number | null> {
  const rows = await db
    .select({
      wait: sql<number>`ceil(extract(epoch from (${askUsage.createdAt} + make_interval(secs => ${windowSeconds}) - now())))::int`,
    })
    .from(askUsage)
    .where(
      and(
        eq(askUsage.userId, userId),
        gt(askUsage.createdAt, sql`now() - make_interval(secs => ${windowSeconds})`),
      ),
    )
    .orderBy(sql`${askUsage.createdAt} desc`)
    .limit(limit);
  if (rows.length < limit) return null;
  return Math.max(1, rows[limit - 1]?.wait ?? 1);
}

/** Checks the per-user daily and ten-minute question limits. Reports the longer wait first. */
export async function checkWindows(
  db: Db,
  userId: number,
  limits: WindowLimits,
): Promise<WindowDecision> {
  const [day, short] = await Promise.all([
    waitFor(db, userId, DAY_SECONDS, limits.questionsPerDay),
    waitFor(db, userId, TEN_MINUTES_SECONDS, limits.questionsPerTenMinutes),
  ]);
  if (day !== null && (short === null || day >= short)) {
    return { ok: false, reason: "daily", retryAfterSeconds: day };
  }
  if (short !== null) return { ok: false, reason: "ten_minutes", retryAfterSeconds: short };
  return { ok: true };
}

// --- concurrency --------------------------------------------------------------------------------

export type SlotDecision =
  | { readonly ok: true; release(): void }
  | { readonly ok: false; readonly reason: "user_busy" | "server_busy" };

/**
 * In-process concurrency: at most one answer per user and `maxConcurrent` answers in the process.
 * `release` is idempotent, so calling it from both a normal end and an abort is safe.
 */
export class AskGate {
  private readonly users = new Set<number>();

  get active(): number {
    return this.users.size;
  }

  tryEnter(userId: number, maxConcurrent: number): SlotDecision {
    if (this.users.has(userId)) return { ok: false, reason: "user_busy" };
    if (this.users.size >= maxConcurrent) return { ok: false, reason: "server_busy" };
    this.users.add(userId);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.users.delete(userId);
      },
    };
  }
}

/** The gate of this server process. */
export const askGate = new AskGate();

// --- usage records ------------------------------------------------------------------------------

/** How a question ended. `_estimated` marks token counts the provider did not report. */
export type UsageOutcome = "started" | "ok" | "cut_off" | "stopped" | `error_${ProviderErrorKind}`;

export interface TokenCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** A rough token count for text the provider did not count: four characters to a token. */
export function estimateTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

export interface StartUsage {
  /** The asking user. Null for the e2e bypass user, who has no row. */
  readonly userId: number | null;
  readonly provider: string;
  readonly excerptCount: number;
  /** Tokens of the query call, already spent. */
  readonly queryTokens?: TokenCounts | null;
}

/**
 * Records that a question was accepted for the model, and removes up to a batch of rows older than
 * 90 days. Returns the row id for `finishUsage`.
 */
export async function startUsage(db: Db, input: StartUsage): Promise<number> {
  const [row] = await db
    .insert(askUsage)
    .values({
      userId: input.userId,
      provider: input.provider,
      excerptCount: input.excerptCount,
      inputTokens: input.queryTokens?.inputTokens ?? 0,
      outputTokens: input.queryTokens?.outputTokens ?? 0,
    })
    .returning({ id: askUsage.id });
  if (!row) throw new Error("ask usage insert returned no row");
  await db.execute(sql`
    delete from ask_usage where id in (
      select id from ask_usage
      where created_at < now() - make_interval(days => ${RETENTION_DAYS})
      order by created_at limit ${CLEANUP_BATCH}
    )`);
  return row.id;
}

/**
 * Closes a usage row: adds the answer's token counts to the query call's, and sets the outcome.
 * `estimated` marks counts that are not the provider's.
 */
export async function finishUsage(
  db: Db,
  id: number,
  result: { outcome: Exclude<UsageOutcome, "started">; tokens: TokenCounts; estimated: boolean },
): Promise<void> {
  await db
    .update(askUsage)
    .set({
      inputTokens: sql`${askUsage.inputTokens} + ${result.tokens.inputTokens}`,
      outputTokens: sql`${askUsage.outputTokens} + ${result.tokens.outputTokens}`,
      outcome: result.estimated ? `${result.outcome}_estimated` : result.outcome,
    })
    .where(eq(askUsage.id, id));
}
