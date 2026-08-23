import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ActivePlanState } from "../session-logic";
import { PlanPanel } from "./PlanPanel";

const threadRef = scopeThreadRef("environment-1" as EnvironmentId, ThreadId.make("thread-1"));

function renderPlan(activePlan: ActivePlanState | null) {
  return renderToStaticMarkup(
    <PlanPanel activePlan={activePlan} proposedPlan={null} cwd={undefined} threadRef={threadRef} />,
  );
}

describe("PlanPanel", () => {
  it("shows current progress, step status, and completed-step duration", () => {
    const html = renderPlan({
      createdAt: "2026-08-23T00:00:00.000Z",
      turnId: null,
      explanation: "Implementing the remote flow",
      steps: [
        { step: "Update the contract", status: "completed", durationMs: 12_000 },
        { step: "Handle reconnects", status: "inProgress" },
        { step: "Add integration coverage", status: "pending" },
      ],
    });

    expect(html).toContain('data-plan-panel="true"');
    expect(html).toContain("Working · 1/3");
    expect(html).toContain("Update the contract");
    expect(html).toContain("12s");
    expect(html).toContain("Handle reconnects");
    expect(html).toContain("Implementing the remote flow");
  });

  it("explains when a thread has no plan yet", () => {
    const html = renderPlan(null);

    expect(html).toContain("No active plan");
    expect(html).toContain("Plans and progress updates from the agent will appear here.");
  });
});
