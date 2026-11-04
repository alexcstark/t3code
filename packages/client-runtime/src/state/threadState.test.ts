import { describe, expect, it } from "@effect/vitest";

import { resolveThreadSyncPhase } from "./threadState.ts";

describe("message synchronization status", () => {
  it.each([
    { status: "cached", error: null, detailExists: true, expected: "offline" },
    { status: "empty", error: null, detailExists: false, expected: "offline" },
    { status: "cached", error: "Connection lost", detailExists: true, expected: "failed" },
    { status: "empty", error: "Sync failed", detailExists: false, expected: "failed" },
    { status: "synchronizing", error: null, detailExists: true, expected: "syncing" },
    { status: "synchronizing", error: null, detailExists: false, expected: "loading" },
    { status: "live", error: null, detailExists: true, expected: null },
    { status: "deleted", error: null, detailExists: false, expected: null },
    { status: "empty", error: null, detailExists: false, shellExists: false, expected: null },
  ] as const)("presents $status with error $error as $expected", (scenario) => {
    expect(resolveThreadSyncPhase({ shellExists: true, ...scenario })).toBe(scenario.expected);
  });
});
