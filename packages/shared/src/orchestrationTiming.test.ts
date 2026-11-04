import { describe, expect, it } from "vite-plus/test";

import { deriveSubagentElapsedMs, formatAgentUpdateAge } from "./orchestrationTiming.ts";

describe("formatAgentUpdateAge", () => {
  const updatedAt = "2026-10-14T12:00:00.000Z";
  const updatedMs = Date.parse(updatedAt);

  it.each([
    [-2_000, "0s"],
    [0, "0s"],
    [45_900, "45s"],
    [60_000, "1m"],
    [125_000, "2m 5s"],
    [3_661_000, "1h 1m 1s"],
  ])("shows the age after %d ms as %s", (elapsedMs, expected) => {
    expect(formatAgentUpdateAge(updatedAt, updatedMs + elapsedMs)).toBe(expected);
  });

  it("omits unknown timing", () => {
    expect(formatAgentUpdateAge("unknown", updatedMs)).toBeNull();
    expect(formatAgentUpdateAge(updatedAt, Number.NaN)).toBeNull();
  });
});

describe("deriveSubagentElapsedMs", () => {
  const startedAt = "2026-09-21T12:00:00.000Z";
  const completedAt = "2026-09-21T12:00:10.000Z";
  const now = Date.parse("2026-09-21T13:00:00.000Z");
  it.each(["idle", "completed", "failed"] as const)(
    "does not count the age of %s work with unknown completion timing",
    (status) => {
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt: null }, now)).toBeNull();
      expect(deriveSubagentElapsedMs({ status, startedAt, completedAt }, now)).toBe(10_000);
    },
  );
  it("counts a resumed activation despite a stale previous completion timestamp", () => {
    expect(deriveSubagentElapsedMs({ status: "running", startedAt, completedAt }, now)).toBe(
      3_600_000,
    );
    expect(
      deriveSubagentElapsedMs({ status: "running", startedAt: null, completedAt: null }, now),
    ).toBeNull();
  });
});
