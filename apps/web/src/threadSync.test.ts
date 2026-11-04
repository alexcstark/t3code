import { describe, expect, it } from "vite-plus/test";

import { resolveThreadSyncPhase } from "./threadSync";

describe("resolveThreadSyncPhase", () => {
  it("reports a failed sync instead of syncing over cached messages", () => {
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "cached",
        error: "Sync failed",
      }),
    ).toBe("failed");
    expect(
      resolveThreadSyncPhase({
        detailExists: false,
        shellExists: true,
        status: "synchronizing",
        error: "Sync failed",
      }),
    ).toBe("failed");
    expect(
      resolveThreadSyncPhase({
        detailExists: true,
        shellExists: true,
        status: "synchronizing",
        error: null,
      }),
    ).toBe("syncing");
  });
});
