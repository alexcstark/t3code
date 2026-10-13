export const terminalShellRootProps = {
  className: "terminal-shell relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background",
  "data-terminal-shell": "true",
} as const;

export type TerminalShellStatusProps = {
  readonly activityState: "working" | "waiting" | "ready";
  readonly canInterrupt: boolean;
  readonly workingStepLabel: string | null;
  readonly activeTerminalCount: number;
};

export function TerminalShellStatus({
  activityState,
  canInterrupt,
  workingStepLabel,
  activeTerminalCount,
}: TerminalShellStatusProps) {
  const isWorking = activityState === "working";
  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2 px-1 pb-1.5 text-2xs text-muted-foreground"
      data-terminal-shell-status="true"
    >
      <span data-terminal-shell-status-state={activityState}>
        {isWorking
          ? (workingStepLabel ?? "Working")
          : activityState === "waiting"
            ? "Waiting for background work"
            : "Ready"}
      </span>
      {canInterrupt ? <span aria-hidden="true">· esc to interrupt</span> : null}
      {activeTerminalCount > 0 ? (
        <span>
          · {activeTerminalCount} terminal{activeTerminalCount === 1 ? "" : "s"} active
        </span>
      ) : null}
    </div>
  );
}
