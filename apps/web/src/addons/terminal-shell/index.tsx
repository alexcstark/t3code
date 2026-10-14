import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatAgentUpdateAge } from "@t3tools/shared/orchestrationTiming";
import { useLayoutEffect, useRef, useState } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { formatChatTimestampTooltip } from "~/timestampFormat";

export const terminalShellRootProps = {
  className: "terminal-shell relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background",
  "data-terminal-shell": "true",
} as const;

export type TerminalShellStatusProps = {
  readonly activityState: "working" | "waiting" | "ready";
  readonly canInterrupt: boolean;
  readonly workingStepLabel: string | null;
  readonly lastAgentUpdateAt?: string | null;
  readonly timestampFormat?: TimestampFormat;
  readonly activeTerminalCount: number;
};

export function TerminalShellStatus({
  activityState,
  canInterrupt,
  workingStepLabel,
  lastAgentUpdateAt = null,
  timestampFormat = "12-hour",
  activeTerminalCount,
}: TerminalShellStatusProps) {
  const isWorking = activityState === "working";
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 pb-1.5 text-2xs text-muted-foreground"
      data-terminal-shell-status="true"
    >
      <span data-terminal-shell-status-state={activityState}>
        {isWorking
          ? (workingStepLabel ?? "Working")
          : activityState === "waiting"
            ? "Waiting for background work"
            : "Ready"}
      </span>
      {isWorking && lastAgentUpdateAt !== null ? (
        <LastAgentUpdate updatedAt={lastAgentUpdateAt} timestampFormat={timestampFormat} />
      ) : null}
      {canInterrupt ? <span aria-hidden="true">· esc to interrupt</span> : null}
      {activeTerminalCount > 0 ? (
        <span>
          · {activeTerminalCount} terminal{activeTerminalCount === 1 ? "" : "s"} active
        </span>
      ) : null}
    </div>
  );
}

function LastAgentUpdate({
  updatedAt,
  timestampFormat,
}: {
  readonly updatedAt: string;
  readonly timestampFormat: TimestampFormat;
}) {
  const textRef = useRef<HTMLTimeElement>(null);
  const [initialNowMs] = useState(Date.now);
  const age = formatAgentUpdateAge(updatedAt, initialNowMs);
  // Initialize before paint; ticking updates only this text, without React commits.
  useLayoutEffect(() => {
    if (!Number.isFinite(Date.parse(updatedAt))) return;
    const update = () => {
      const text = formatAgentUpdateAge(updatedAt, Date.now());
      if (textRef.current && text !== null && textRef.current.textContent !== text) {
        textRef.current.textContent = text;
      }
    };
    update();
    const intervalId = setInterval(update, 1_000);
    return () => clearInterval(intervalId);
  }, [updatedAt]);
  if (age === null) return null;
  return (
    <span aria-live="off" className="shrink-0 tabular-nums">
      <Tooltip>
        <TooltipTrigger render={<span />}>
          · last update{" "}
          <time ref={textRef} dateTime={updatedAt}>
            {age}
          </time>{" "}
          ago
        </TooltipTrigger>
        <TooltipPopup>
          Last agent update: {formatChatTimestampTooltip(updatedAt, timestampFormat)}
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
