/**
 * Deterministic time formatting for pages (task 9.2). Pure: no React, no database.
 *
 * Every function takes the current time as an argument and uses a fixed locale and time zone, so
 * the output depends only on its inputs: the same server render, unit test and browser test give
 * the same text on any machine, whatever its locale or `TZ`.
 */

const LOCALE = "en-GB";

const absoluteFormat = new Intl.DateTimeFormat(LOCALE, {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
  hourCycle: "h23",
});

const relativeFormat = new Intl.RelativeTimeFormat(LOCALE, { numeric: "auto" });

/** `14 Mar 2026, 09:30 UTC`, or an empty string for an invalid date. */
export function formatAbsoluteTime(date: Date): string {
  return Number.isNaN(date.getTime()) ? "" : `${absoluteFormat.format(date)} UTC`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * `3 hours ago`, `yesterday`, `last month`, or `in 5 minutes` when `date` is ahead of `now`
 * (clock skew between the sync host and this one). Under a minute is `just now`. Months are 30
 * days and years 365; this is a hint next to the absolute time, not a calendar calculation.
 */
export function formatRelativeTime(date: Date, now: Date): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return "";
  const abs = Math.abs(seconds);
  if (abs < MINUTE) return "just now";
  if (abs < HOUR) return relativeFormat.format(Math.trunc(seconds / MINUTE), "minute");
  if (abs < DAY) return relativeFormat.format(Math.trunc(seconds / HOUR), "hour");
  if (abs < MONTH) return relativeFormat.format(Math.trunc(seconds / DAY), "day");
  if (abs < YEAR) return relativeFormat.format(Math.trunc(seconds / MONTH), "month");
  return relativeFormat.format(Math.trunc(seconds / YEAR), "year");
}
