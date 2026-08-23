export const terminalShellRootProps = {
  className: "terminal-shell relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background",
  "data-terminal-shell": "true",
} as const;

export type TerminalShellStatusProps = {
  readonly isWorking: boolean;
  readonly workingStepLabel: string | null;
  readonly activeTerminalCount: number;
};

export function TerminalShellStatus({
  isWorking,
  workingStepLabel,
  activeTerminalCount,
}: TerminalShellStatusProps) {
  return (
    <div
      aria-live="polite"
      className="flex items-center gap-2 px-1 pb-1.5 text-[11px] text-muted-foreground"
      data-terminal-shell-status="true"
    >
      <span data-terminal-shell-status-state={isWorking ? "working" : "ready"}>
        {isWorking ? (workingStepLabel ?? "Working") : "Ready"}
      </span>
      {isWorking ? <span aria-hidden="true">· esc to interrupt</span> : null}
      {activeTerminalCount > 0 ? (
        <span>
          · {activeTerminalCount} terminal{activeTerminalCount === 1 ? "" : "s"} active
        </span>
      ) : null}
    </div>
  );
}
