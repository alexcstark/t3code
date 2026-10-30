import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { render } from "../../test/render";
import { PlanPanel } from "./PlanPanel";

const threadRef = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("PlanPanel", () => {
  it("shows current progress, completed-step duration, and remaining work", async () => {
    await using screen = await render(
      <PlanPanel
        activePlan={{
          createdAt: "2026-08-23T00:00:00.000Z",
          runId: null,
          explanation: "Implementing the remote flow",
          steps: [
            { step: "Update the contract", status: "completed", durationMs: 12000 },
            { step: "Handle reconnects", status: "inProgress" },
            { step: "Add integration coverage", status: "pending" },
          ],
        }}
        proposedPlan={null}
        cwd={undefined}
        threadRef={threadRef}
      />,
    );
    await expect.element(screen.getByText("Working · 1/3")).toBeVisible();
    await expect.element(screen.getByText("Update the contract")).toBeVisible();
    await expect.element(screen.getByText("12s")).toBeVisible();
    await expect.element(screen.getByText("Handle reconnects")).toBeVisible();
    await expect.element(screen.getByText("Implementing the remote flow")).toBeVisible();
  });
  it("explains when a thread has no plan yet", async () => {
    await using screen = await render(
      <PlanPanel activePlan={null} proposedPlan={null} cwd={undefined} threadRef={threadRef} />,
    );
    await expect.element(screen.getByText("No active plan")).toBeVisible();
    await expect
      .element(screen.getByText("Plans and progress updates from the agent will appear here."))
      .toBeVisible();
  });
});
