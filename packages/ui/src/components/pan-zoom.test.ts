import { describe, expect, it } from "vitest";

import {
  INITIAL_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  clampPan,
  clampScale,
  panBy,
  percentOf,
  transformOf,
  wheelFactor,
  zoomAt,
} from "./pan-zoom";

describe("clampScale", () => {
  it("keeps the scale inside the limits", () => {
    expect(clampScale(0.01)).toBe(MIN_SCALE);
    expect(clampScale(100)).toBe(MAX_SCALE);
    expect(clampScale(2)).toBe(2);
  });

  it("falls back to 1 for non-finite input", () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("zoomAt", () => {
  it("zooms about the center without moving the view", () => {
    expect(zoomAt(INITIAL_VIEW, 2, 0, 0)).toEqual({ scale: 2, x: 0, y: 0 });
  });

  it("keeps the point under the cursor fixed", () => {
    // A point at (100, 50) from the center; after zooming 1 -> 2 it must still map to the same
    // screen spot: screen = p = t + s * q, with q the content coordinate under the cursor.
    const before = INITIAL_VIEW;
    const after = zoomAt(before, 2, 100, 50);
    const q = { x: (100 - before.x) / before.scale, y: (50 - before.y) / before.scale };
    expect(after.x + after.scale * q.x).toBeCloseTo(100);
    expect(after.y + after.scale * q.y).toBeCloseTo(50);
  });

  it("clamps at both limits and then does not move", () => {
    const max = zoomAt(INITIAL_VIEW, 100, 10, 10);
    expect(max.scale).toBe(MAX_SCALE);
    expect(zoomAt(max, 1000, 30, 30)).toBe(max);
    const min = zoomAt(INITIAL_VIEW, 0.0001, 10, 10);
    expect(min.scale).toBe(MIN_SCALE);
    expect(zoomAt(min, 0.00001, 30, 30)).toBe(min);
  });
});

describe("panBy and clampPan", () => {
  it("moves by the delta", () => {
    expect(panBy(INITIAL_VIEW, 10, -20)).toEqual({ scale: 1, x: 10, y: -20 });
  });

  it("does not clamp when the stage size is unknown or zero", () => {
    expect(panBy(INITIAL_VIEW, 99999, 0)).toMatchObject({ x: 99999 });
    expect(panBy(INITIAL_VIEW, 99999, 0, { width: 0, height: 0 })).toMatchObject({ x: 99999 });
  });

  it("keeps part of the diagram in sight", () => {
    const size = { width: 800, height: 600 };
    const view = panBy(INITIAL_VIEW, 99999, -99999, size);
    // (800 * 2) / 2 - 48 and (600 * 2) / 2 - 48
    expect(view.x).toBe(752);
    expect(view.y).toBe(-552);
    expect(clampPan({ scale: 1, x: 0, y: 0 }, size)).toEqual({ scale: 1, x: 0, y: 0 });
  });
});

describe("wheelFactor", () => {
  it("zooms in for negative deltas and out for positive ones", () => {
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(100, 0, false)).toBeLessThan(1);
    expect(wheelFactor(0, 0, false)).toBe(1);
  });

  it("is stronger for pinch (ctrl) and bounded for huge deltas", () => {
    expect(wheelFactor(-10, 0, true)).toBeGreaterThan(wheelFactor(-10, 0, false));
    expect(wheelFactor(-1e9, 0, false)).toBe(wheelFactor(-240, 0, false));
    expect(wheelFactor(-1, 1, false)).toBeCloseTo(wheelFactor(-16, 0, false));
  });
});

describe("formatting", () => {
  it("builds the transform and percentage", () => {
    expect(transformOf({ scale: 1.5, x: 10.12345, y: -2 })).toBe(
      "translate(10.123px, -2px) scale(1.5)",
    );
    expect(percentOf({ scale: 1.25, x: 0, y: 0 })).toBe(125);
  });
});
