import { describe, expect, it } from "vitest";

import { formatAbsoluteDate, formatAbsoluteTime, formatRelativeTime } from "./time";

const NOW = new Date("2026-10-10T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("formatAbsoluteTime", () => {
  it("uses a fixed locale, 24-hour clock and UTC", () => {
    expect(formatAbsoluteTime(new Date("2026-03-14T09:30:00Z"))).toBe("14 Mar 2026, 09:30 UTC");
    expect(formatAbsoluteTime(new Date("2026-03-14T21:05:59Z"))).toBe("14 Mar 2026, 21:05 UTC");
    expect(formatAbsoluteTime(new Date("2026-12-31T23:59:00Z"))).toBe("31 Dec 2026, 23:59 UTC");
  });

  it("does not depend on the process time zone", () => {
    const before = process.env.TZ;
    process.env.TZ = "Pacific/Auckland";
    try {
      expect(formatAbsoluteTime(new Date("2026-03-14T09:30:00Z"))).toBe("14 Mar 2026, 09:30 UTC");
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatAbsoluteTime(new Date("nope"))).toBe("");
  });
});

describe("formatRelativeTime", () => {
  it("says just now under a minute", () => {
    expect(formatRelativeTime(ago(0), NOW)).toBe("just now");
    expect(formatRelativeTime(ago(59 * SECOND), NOW)).toBe("just now");
  });

  it("counts minutes, hours, days, months and years back", () => {
    expect(formatRelativeTime(ago(MINUTE), NOW)).toBe("1 minute ago");
    expect(formatRelativeTime(ago(5 * MINUTE + 30 * SECOND), NOW)).toBe("5 minutes ago");
    expect(formatRelativeTime(ago(3 * HOUR), NOW)).toBe("3 hours ago");
    expect(formatRelativeTime(ago(DAY), NOW)).toBe("yesterday");
    expect(formatRelativeTime(ago(6 * DAY), NOW)).toBe("6 days ago");
    expect(formatRelativeTime(ago(45 * DAY), NOW)).toBe("last month");
    expect(formatRelativeTime(ago(200 * DAY), NOW)).toBe("6 months ago");
    expect(formatRelativeTime(ago(400 * DAY), NOW)).toBe("last year");
    expect(formatRelativeTime(ago(1100 * DAY), NOW)).toBe("3 years ago");
  });

  it("handles a timestamp slightly in the future (clock skew)", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() + 20 * SECOND), NOW)).toBe("just now");
    expect(formatRelativeTime(new Date(NOW.getTime() + 5 * MINUTE), NOW)).toBe("in 5 minutes");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatRelativeTime(new Date("nope"), NOW)).toBe("");
  });
});

describe("formatAbsoluteDate", () => {
  it("formats the UTC calendar date, whatever the time of day", () => {
    expect(formatAbsoluteDate(new Date("2026-03-14T00:00:00Z"))).toBe("14 Mar 2026");
    expect(formatAbsoluteDate(new Date("2026-03-14T23:59:59Z"))).toBe("14 Mar 2026");
  });

  it("handles a leap day and very old and far future years", () => {
    expect(formatAbsoluteDate(new Date("2024-02-29T00:00:00Z"))).toBe("29 Feb 2024");
    expect(formatAbsoluteDate(new Date("1066-10-14T00:00:00Z"))).toBe("14 Oct 1066");
    expect(formatAbsoluteDate(new Date("9999-12-31T00:00:00Z"))).toBe("31 Dec 9999");
  });

  it("returns an empty string for an invalid date", () => {
    expect(formatAbsoluteDate(new Date(Number.NaN))).toBe("");
  });
});
