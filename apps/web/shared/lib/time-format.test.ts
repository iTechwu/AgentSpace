import { describe, expect, it } from "vitest";
import { formatCompactTimestamp } from "./time-format";

describe("formatCompactTimestamp", () => {
  const now = new Date(2026, 4, 11, 18, 30);

  it("shows hour and minute for today", () => {
    expect(formatCompactTimestamp(new Date(2026, 4, 11, 8, 5), { now })).toBe("08:05");
  });

  it("shows month and day for non-today timestamps in the current year", () => {
    expect(formatCompactTimestamp(new Date(2026, 3, 25, 8, 5), { now })).toBe("04/25");
  });

  it("shows year, month, and day for timestamps outside the current year", () => {
    expect(formatCompactTimestamp(new Date(2025, 3, 25, 8, 5), { now })).toBe("2025/04/25");
  });

  it("keeps legacy time-only strings readable", () => {
    expect(formatCompactTimestamp("15:09", { now })).toBe("15:09");
  });

  it("does not reinterpret already compact date labels", () => {
    expect(formatCompactTimestamp("04/25", { now })).toBe("04/25");
    expect(formatCompactTimestamp("2025/04/25", { now })).toBe("2025/04/25");
  });

  it("uses an empty fallback for missing values", () => {
    expect(formatCompactTimestamp(undefined, { emptyFallback: "—", now })).toBe("—");
  });
});
