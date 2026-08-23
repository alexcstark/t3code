import type { ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, CircleIcon, ListTodoIcon } from "lucide-react";

import { proposedPlanTitle } from "../proposedPlan";
import type { ActivePlanState, LatestProposedPlanState } from "../session-logic";
import ChatMarkdown from "./ChatMarkdown";
import { cn } from "~/lib/utils";
import { ScrollArea } from "./ui/scroll-area";

interface PlanPanelProps {
  activePlan: ActivePlanState | null;
  proposedPlan: LatestProposedPlanState | null;
  cwd: string | undefined;
  threadRef: ScopedThreadRef;
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function PlanStep({ step }: { step: ActivePlanState["steps"][number] }) {
  const completed = step.status === "completed";
  const current = step.status === "inProgress";
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-2 rounded-md px-1.5 py-1.5 text-xs",
        completed ? "text-muted-foreground/65" : "text-foreground/85",
        current && "bg-accent/40",
      )}
    >
      <span className="mt-0.5 shrink-0 text-muted-foreground/60">
        {completed ? (
          <CheckIcon aria-hidden className="size-3.5 text-success" />
        ) : current ? (
          <span
            aria-hidden
            className="mt-0.5 block size-2 rounded-full bg-primary ring-2 ring-primary/20"
          />
        ) : (
          <CircleIcon aria-hidden className="size-3.5" />
        )}
      </span>
      <span className={cn("min-w-0 flex-1", completed && "line-through")}>{step.step}</span>
      {step.durationMs !== undefined ? (
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {formatDuration(step.durationMs)}
        </span>
      ) : null}
    </div>
  );
}

function EmptyPlanState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 text-center">
      <div className="max-w-56">
        <ListTodoIcon aria-hidden className="mx-auto size-5 text-muted-foreground/60" />
        <p className="mt-3 text-sm font-medium text-foreground/85">No active plan</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Plans and progress updates from the agent will appear here.
        </p>
      </div>
    </div>
  );
}

export function PlanPanel({ activePlan, proposedPlan, cwd, threadRef }: PlanPanelProps) {
  if (!activePlan && !proposedPlan) {
    return <EmptyPlanState />;
  }

  const planTitle = proposedPlan
    ? (proposedPlanTitle(proposedPlan.planMarkdown) ?? "Implementation plan")
    : "Current plan";

  if (!activePlan && proposedPlan) {
    return (
      <ScrollArea className="min-h-0 flex-1" data-plan-panel>
        <div className="space-y-4 p-4">
          <div className="flex items-start gap-2">
            <ListTodoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <h2 className="truncate text-sm font-medium">{planTitle}</h2>
              <p className="mt-1 text-xs text-muted-foreground">Proposed plan · not started</p>
            </div>
          </div>
          <ChatMarkdown text={proposedPlan.planMarkdown} cwd={cwd} threadRef={threadRef} />
        </div>
      </ScrollArea>
    );
  }

  if (!activePlan) {
    return <EmptyPlanState />;
  }

  const completedCount = activePlan.steps.filter((step) => step.status === "completed").length;
  const currentStep =
    activePlan.steps.find((step) => step.status === "inProgress") ??
    activePlan.steps.find((step) => step.status === "pending");
  const allComplete = activePlan.steps.length > 0 && completedCount === activePlan.steps.length;
  const status = allComplete
    ? "Complete"
    : currentStep
      ? `Working · ${completedCount}/${activePlan.steps.length}`
      : "Waiting for the agent";
  const occurrences = new Map<string, number>();
  const keyedSteps = activePlan.steps.map((step) => {
    const occurrence = occurrences.get(step.step) ?? 0;
    occurrences.set(step.step, occurrence + 1);
    return { key: `${step.step}:${occurrence}`, step };
  });

  return (
    <ScrollArea className="min-h-0 flex-1" data-plan-panel>
      <div className="space-y-4 p-4">
        <div className="flex items-start gap-2">
          <ListTodoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-medium">{planTitle}</h2>
            <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden
                className={cn("size-1.5 rounded-full", allComplete ? "bg-success" : "bg-primary")}
              />
              {status}
            </p>
          </div>
        </div>

        <div>
          <div
            className="flex gap-1"
            aria-label={`${completedCount} of ${activePlan.steps.length} steps complete`}
          >
            {keyedSteps.map(({ key, step }) => (
              <span
                key={key}
                aria-hidden
                className={cn(
                  "h-1 min-w-0 flex-1 rounded-full",
                  step.status === "completed"
                    ? "bg-success"
                    : step.status === "inProgress"
                      ? "bg-primary"
                      : "bg-muted-foreground/25",
                )}
              />
            ))}
          </div>
          <div className="mt-1.5 flex justify-between gap-2 text-[11px] text-muted-foreground">
            <span className="min-w-0 truncate">
              {currentStep ? currentStep.step : allComplete ? "All steps complete" : "Plan ready"}
            </span>
            <span className="shrink-0 tabular-nums">
              {completedCount}/{activePlan.steps.length}
            </span>
          </div>
        </div>

        <div className="space-y-0.5">
          {keyedSteps.map(({ key, step }) => (
            <PlanStep key={key} step={step} />
          ))}
        </div>

        {activePlan.explanation ? (
          <div className="border-l-2 border-primary/70 bg-accent/30 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            {activePlan.explanation}
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
}
