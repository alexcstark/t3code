import { describe, expect, it } from "vite-plus/test";

import { resolveCodexRemainingUsage } from "./SidebarCodexUsage";

describe("resolveCodexRemainingUsage", () => {
  it("converts Codex rolling windows into remaining percentages", () => {
    expect(
      resolveCodexRemainingUsage({
        primary: { usedPercent: 25, windowDurationMins: 300 },
        secondary: { usedPercent: 60, windowDurationMins: 10_080 },
      }),
    ).toEqual([
      { label: "5h", remainingPercent: 75 },
      { label: "7d", remainingPercent: 40 },
    ]);
  });

  it("clamps provider values to the displayable percentage range", () => {
    expect(
      resolveCodexRemainingUsage({
        primary: { usedPercent: 140, windowDurationMins: 300 },
        secondary: { usedPercent: -10, windowDurationMins: 10_080 },
      }),
    ).toEqual([
      { label: "5h", remainingPercent: 0 },
      { label: "7d", remainingPercent: 100 },
    ]);
  });
});
